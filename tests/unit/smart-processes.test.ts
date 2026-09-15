import { describe, expect, it } from 'vitest'
import {
  buildCreateFieldCall,
  buildCreateSmartProcessCall,
  buildFieldEntityId,
  buildFieldName,
  findTypeByTitle,
  normalizeFieldName,
  planMissingFields,
  readCreatedRef,
  readFieldNames,
  readNextOffset,
  readTypes,
  SURVEY_FIELDS,
  SURVEY_SP_TITLE,
  TEMPLATE_FIELDS,
  TEMPLATE_SP_TITLE,
} from '../../server/domain/portals/smart-processes'

/**
 * Почти каждое утверждение здесь — про факт, подтверждённый на живом портале у соседнего
 * проекта и расходящийся с документацией. Ошибка в любом из них не ломает сборку: она
 * создаёт дубликат смарт-процесса при лимите тарифа или молча теряет поля.
 */

describe('имена и адреса полей', () => {
  it('поле создаётся под id ТИПА, а не под entityTypeId', () => {
    // Форма с entityTypeId отвергается порталом: «not allowed to view custom field settings».
    expect(buildFieldEntityId(13)).toBe('CRM_13')
    expect(buildFieldName(13, 'SCORE')).toBe('UF_CRM_13_SCORE')
  })

  it.each([
    ['UF_CRM_13_OP_DATE', 'созданная форма'],
    ['UF_CRM13_OP_DATE', 'слитная форма из списка'],
    ['ufCrm13OpDate', 'camel-форма из списка'],
  ])('сводит к одному виду %s (%s)', (name) => {
    // Портал возвращает имя не в той форме, в какой поле создавали. Без нормализации
    // существующее поле считается отсутствующим, пересоздание падает на дубликате
    // и обрывает цикл до полей, стоящих ниже.
    expect(normalizeFieldName(name)).toBe('ufcrm13opdate')
  })

  it('различает наши постфиксы после нормализации', () => {
    const normalized = TEMPLATE_FIELDS.map(f => normalizeFieldName(buildFieldName(13, f.postfix)))

    expect(new Set(normalized).size).toBe(TEMPLATE_FIELDS.length)
  })
})

describe('план создания полей', () => {
  it('не планирует ничего, когда всё уже есть', () => {
    const existing = SURVEY_FIELDS.map(f => buildFieldName(13, f.postfix))

    expect(planMissingFields(13, SURVEY_FIELDS, existing)).toEqual([])
  })

  it('узнаёт существующие поля в чужой форме имени', () => {
    // Ровно тот случай, на котором у соседа часть полей не появлялась никогда.
    const existing = SURVEY_FIELDS.map(f => `ufCrm13${f.postfix.replace(/_/g, '')}`)

    expect(planMissingFields(13, SURVEY_FIELDS, existing)).toEqual([])
  })

  it('планирует только недостающие', () => {
    const existing = [buildFieldName(13, 'STATE')]
    const planned = planMissingFields(13, SURVEY_FIELDS, existing)

    expect(planned).toHaveLength(SURVEY_FIELDS.length - 1)
    expect(JSON.stringify(planned)).not.toContain('UF_CRM_13_STATE')
  })
})

describe('состав смарт-процессов', () => {
  it('их ровно два и заголовки стабильны', () => {
    // По заголовку смарт-процесс находится повторно, если наш идентификатор потерян.
    // Переименование здесь = второй смарт-процесс на портале при лимите 150.
    expect([TEMPLATE_SP_TITLE, SURVEY_SP_TITLE]).toEqual(['Шаблон опроса', 'Опрос'])
  })

  it('не передаёт entityTypeId: его назначает портал', () => {
    // Документация подаёт это поле как выбор вызывающего, но выбранный номер
    // может быть занят на конкретном портале, а узнать это заранее нельзя.
    const call = buildCreateSmartProcessCall(SURVEY_SP_TITLE)

    expect(JSON.stringify(call.params)).not.toContain('entityTypeId')
    expect(call.method).toBe('crm.type.add')
  })

  it('балл создаётся с точностью до сотых', () => {
    // Без PRECISION `double` округляется до целого — балл 7,5 стал бы 8.
    const score = SURVEY_FIELDS.find(f => f.postfix === 'SCORE')
    const call = buildCreateFieldCall(13, score!)

    expect((call.params.field as { settings?: unknown }).settings).toEqual({ PRECISION: 2 })
  })

  it('поле без настроек не получает пустой settings', () => {
    const call = buildCreateFieldCall(13, { postfix: 'CODE', userTypeId: 'string', label: 'Код' })

    expect(call.params.field).not.toHaveProperty('settings')
  })
})

describe('разбор ответов портала', () => {
  it('читает оба идентификатора созданного смарт-процесса', () => {
    // Нужны ОБА: entityTypeId адресует элементы, id — поля.
    expect(readCreatedRef({ result: { type: { id: 16, entityTypeId: 2024 } } }))
      .toEqual({ entityTypeId: 2024, id: 16 })
  })

  it.each<[unknown, string]>([
    [{ result: { type: { id: 16 } } }, 'нет entityTypeId'],
    [{ result: { type: { entityTypeId: 2024 } } }, 'нет id'],
    [{ result: {} }, 'нет type'],
    [null, 'нет ответа'],
  ])('отказывается читать неполный ответ (%#: %s)', (response) => {
    expect(readCreatedRef(response)).toBeNull()
  })

  it('находит наш смарт-процесс среди чужих по заголовку', () => {
    const types = [
      { id: 1, entityTypeId: 1030, title: 'Договоры' },
      { id: 7, entityTypeId: 1044, title: 'Опрос' },
    ]

    expect(findTypeByTitle(types, 'Опрос')).toEqual({ entityTypeId: 1044, id: 7 })
    expect(findTypeByTitle(types, 'Шаблон опроса')).toBeNull()
  })

  it('не путает похожий заголовок', () => {
    // Иначе чужой «Опросник» стал бы нашим, и мы начали бы писать в него.
    expect(findTypeByTitle([{ id: 7, entityTypeId: 1044, title: 'Опросник' }], 'Опрос')).toBeNull()
  })

  it('читает имена существующих полей', () => {
    const response = { result: { fields: [{ fieldName: 'UF_CRM_13_STATE' }, { noName: 1 }] } }

    expect(readFieldNames(response)).toEqual(['UF_CRM_13_STATE'])
  })

  it('читает смещение следующей страницы', () => {
    // Без перелистывания наш смарт-процесс со второй страницы не найдётся,
    // и мы создадим дубликат при лимите тарифа.
    expect(readNextOffset({ next: 50 })).toBe(50)
    expect(readNextOffset({ next: 0 })).toBeNull()
    expect(readNextOffset({})).toBeNull()
  })

  it('не падает на мусоре вместо списка', () => {
    expect(readTypes(null)).toEqual([])
    expect(readTypes({ result: { types: 'не массив' } })).toEqual([])
    expect(readFieldNames({ result: {} })).toEqual([])
  })
})
