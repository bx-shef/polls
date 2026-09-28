import { describe, expect, it } from 'vitest'
import {
  buildCreateCrmFieldCall,
  buildWriteScoreCall,
  CONTACT_ENTITY,
  crmFieldName,
  DEAL_ENTITY,
  LAST_SCORE_CODE,
  LAST_SURVEY_AT_CODE,
  planCrmFieldLabels,
  buildListFieldsCall,
  planMissingCrmFields,
  readCrmFields,
  SCORE_FIELDS,
  SCORED_ENTITIES,
} from '../../server/domain/portals/crm-fields'
import { COMPANY_ENTITY_TYPE_ID } from '../../server/domain/portals/smart-processes'

/**
 * Поля «оценка» и «дата опроса» на сделке и контакте клиента (issue #23).
 *
 * Балл живёт на элементе смарт-процесса «Опрос», а он дочерняя сущность сделки: до его полей
 * не дотягивается ни фильтр в списке сделок, ни робот на стадии. То есть обещанное клиенту
 * «покажи сделки с оценкой ниже семи» без этих двух полей не работает вовсе.
 *
 * Здесь держатся те детали, ошибка в которых даёт ровно тот исход: поля созданы, а обещание
 * по-прежнему не выполнено — и заметить это можно только глазами в чужой CRM.
 */

describe('создание поля на сущности CRM', () => {
  const score = SCORE_FIELDS.find(field => field.code === LAST_SCORE_CODE)!

  it('просит показывать поле в ФИЛЬТРЕ — в этом вся задача', () => {
    // ⚠ ГЛАВНЫЙ ГВАРД ФАЙЛА. Без `SHOW_FILTER` поле на сделке существует, значение в нём
    // правильное, а в фильтре списка сделок его нет — то есть «покажи сделки с оценкой
    // ниже семи» по-прежнему невозможно. Всё сделано и ничего не получилось.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, score).params.fields as Record<string, unknown>

    expect(fields.SHOW_FILTER).toBe('Y')
  })

  it('у балла стоит PRECISION — иначе портал округлит до целого', () => {
    // ⚠ Подтверждено соседом на живом портале: `double` без `PRECISION` округляется.
    // Балл 7,5 стал бы восьмёркой, и фильтр «ниже семи» врал бы ровно на той границе,
    // ради которой его и настраивают.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, score).params.fields as Record<string, unknown>

    expect(fields.USER_TYPE_ID).toBe('double')
    expect(fields.SETTINGS).toEqual({ PRECISION: 2 })
  })

  it('имя поля идёт БЕЗ префикса — портал добавляет его сам', () => {
    // ⚠ Документация `crm.deal.userfield.add`: «К коду добавляется префикс UF_CRM_».
    // Передав имя уже с префиксом, мы получили бы `UF_CRM_UF_CRM_…` — поле, которое
    // потом не найдём при сверке и создадим второй раз.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, score).params.fields as Record<string, unknown>

    expect(fields.FIELD_NAME).toBe(LAST_SCORE_CODE)
    expect(String(fields.FIELD_NAME)).not.toContain('UF_CRM')
  })

  it('править руками не даёт: оценку ставит приложение', () => {
    // Портал по умолчанию разрешает правку в списке. Отредактированная руками оценка —
    // это оценка клиента, которой клиент не ставил.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, score).params.fields as Record<string, unknown>

    expect(fields.EDIT_IN_LIST).toBe('N')
  })

  it('у сделки и контакта разные методы создания', () => {
    expect(buildCreateCrmFieldCall(DEAL_ENTITY, score).method).toBe('crm.deal.userfield.add')
    expect(buildCreateCrmFieldCall(CONTACT_ENTITY, score).method).toBe('crm.contact.userfield.add')
  })
})

describe('какие сущности трогаем', () => {
  it('ровно две: сделка и контакт', () => {
    expect(SCORED_ENTITIES.map(entity => entity.title)).toEqual(['сделка', 'контакт'])
  })

  it('компанию НЕ трогаем', () => {
    // ⚠ Осознанный отказ, а не забывчивость. У компании сделок много, и «последний балл»
    // по компании — это балл случайной из них: число, которое выглядит осмысленным
    // и таковым не является. Плюс каждое поле на чужой сущности остаётся у клиента
    // навсегда — их не удалить вместе с приложением.
    expect(SCORED_ENTITIES.map(entity => entity.entityTypeId)).not.toContain(COMPANY_ENTITY_TYPE_ID)
  })
})

describe('идемпотентность: существующее поле не создаётся второй раз', () => {
  it('узнаёт своё поле в ответе портала', () => {
    const existing = readCrmFields({ result: [{ ID: '11', FIELD_NAME: crmFieldName(LAST_SCORE_CODE) }] }).map(field => field.name)

    expect(planMissingCrmFields(DEAL_ENTITY, SCORE_FIELDS, existing))
      .toHaveLength(SCORE_FIELDS.length - 1)
  })

  it('узнаёт его и в ДРУГОМ написании', () => {
    // ⚠ Тот же приём и та же причина, что у полей смарт-процесса: портал уже показывал,
    // что отдаёт имя не в той форме, в какой принимает. Прямое сравнение однажды сочло бы
    // существующее поле отсутствующим, создание упало бы на дубликате, и идемпотентность
    // установки — главное её свойство — сломалась бы молча.
    const existing = ['ufCrmShefSurveyScore', 'UFCRMSHEFSURVEYAT']

    expect(planMissingCrmFields(DEAL_ENTITY, SCORE_FIELDS, existing)).toEqual([])
  })

  it('на пустом портале планирует оба поля', () => {
    expect(planMissingCrmFields(DEAL_ENTITY, SCORE_FIELDS, [])).toHaveLength(2)
  })

  it('мусор в ответе портала не считает полями', () => {
    expect(readCrmFields({ result: [{ ID: '1', FIELD_NAME: '' }, {}, null, 'строка'] })).toEqual([])
    expect(readCrmFields(null)).toEqual([])
  })
})

describe('запись балла в сущность', () => {
  const call = buildWriteScoreCall(DEAL_ENTITY, 351, 7.5, new Date('2026-09-24T14:20:00Z'))
  const fields = call.params.fields as Record<string, unknown>

  it('идёт `crm.item.update` оригинальными именами полей', () => {
    // ⚠ Так во всём проекте. Смешивать `crm.deal.update` и `crm.item.update` на одних
    // и тех же данных — способ однажды не найти поле там, где оно есть.
    expect(call.method).toBe('crm.item.update')
    expect(call.params.useOriginalUfNames).toBe('Y')
  })

  it('кладёт балл как есть, не округляя', () => {
    expect(fields[crmFieldName(LAST_SCORE_CODE)]).toBe(7.5)
  })

  it('дату кладёт днём, без времени', () => {
    // Поле заведено типом `date`, и портал всё равно отрежет время. Отдаём то, что он ждёт.
    expect(fields[crmFieldName(LAST_SURVEY_AT_CODE)]).toBe('2026-09-24')
  })

  it('пишет ровно два поля и ни одного чужого', () => {
    // ⚠ Это ЧУЖАЯ сущность: каждое лишнее поле в `fields` затирает данные клиента.
    expect(Object.keys(fields).sort())
      .toEqual([crmFieldName(LAST_SCORE_CODE), crmFieldName(LAST_SURVEY_AT_CODE)].sort())
  })
})

describe('подписи полей сделки и контакта: метка владельца', () => {
  it('новое поле создаётся с меткой во всех трёх подписях', () => {
    // Решение владельца 28.09 (issue #84, пункт 22): наше поле в карточке сделки клиента
    // отличается от его собственных с первого взгляда.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, SCORE_FIELDS[0]!).params.fields as Record<string, unknown>

    expect([fields.LABEL, fields.EDIT_FORM_LABEL, fields.LIST_COLUMN_LABEL, fields.LIST_FILTER_LABEL])
      .toEqual(Array(4).fill('[sh] Оценка клиента'))
  })

  it('старое поле получает метку разом во всех трёх подписях', () => {
    // Каждая подпись в `crm.<entity>.userfield.update` перезаписывается целиком: поменяв одну,
    // мы оставили бы в фильтре и колонке старое имя.
    const calls = planCrmFieldLabels(DEAL_ENTITY, SCORE_FIELDS, [{ id: 11, name: 'UF_CRM_SHEF_SURVEY_SCORE', label: 'Оценка клиента' }])

    expect(calls).toEqual([{
      method: 'crm.deal.userfield.update',
      params: { id: 11, fields: { LIST_COLUMN_LABEL: '[sh] Оценка клиента', LIST_FILTER_LABEL: '[sh] Оценка клиента', EDIT_FORM_LABEL: '[sh] Оценка клиента' } },
    }])
  })

  it('просит список полей с языком — без него подписей в ответе нет', () => {
    // Замерено 28.09: без `filter.LANG` портал отдаёт поля без подписей, и миграция переписывала
    // бы наши поля при каждом прогоне. Нашли `/review` и `/code-review` в PR #87.
    expect(buildListFieldsCall(DEAL_ENTITY)).toEqual({ method: 'crm.deal.userfield.list', params: { filter: { LANG: 'ru' } } })
    expect(buildListFieldsCall(CONTACT_ENTITY, 50).params).toEqual({ filter: { LANG: 'ru' }, start: 50 })
  })

  it('узнаёт своё поле в чужом написании имени', () => {
    // Гвард из мутационного прогона панели PR #87: без нормализации имени тесты молчали —
    // все фикстуры были в каноничной форме.
    const calls = planCrmFieldLabels(DEAL_ENTITY, SCORE_FIELDS, [{ id: 11, name: 'ufCrmShefSurveyScore', label: 'Оценка клиента' }])

    expect(calls.map(call => call.params.id)).toEqual([11])
  })

  it('уже помеченное и чужое не трогает', () => {
    const existing = [
      { id: 11, name: 'UF_CRM_SHEF_SURVEY_SCORE', label: '[sh] Оценка клиента' },
      { id: 12, name: 'UF_CRM_CLIENT_OWN', label: 'Своё поле клиента' },
    ]

    expect(planCrmFieldLabels(CONTACT_ENTITY, SCORE_FIELDS, existing)).toEqual([])
  })

  it('читает подпись и строкой, и по языкам; без идентификатора поле пропускает', () => {
    const response = {
      result: [
        { ID: '11', FIELD_NAME: 'UF_CRM_SHEF_SURVEY_SCORE', EDIT_FORM_LABEL: 'Оценка' },
        { ID: '12', FIELD_NAME: 'UF_CRM_SHEF_SURVEY_AT', EDIT_FORM_LABEL: { ru: 'Дата', en: 'Date' } },
        { FIELD_NAME: 'UF_CRM_NO_ID', EDIT_FORM_LABEL: 'Без ID' },
      ],
    }

    expect(readCrmFields(response)).toEqual([
      { id: 11, name: 'UF_CRM_SHEF_SURVEY_SCORE', label: 'Оценка' },
      { id: 12, name: 'UF_CRM_SHEF_SURVEY_AT', label: 'Дата' },
    ])
  })
})
