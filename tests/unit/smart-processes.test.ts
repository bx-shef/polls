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
  readNextOffset,
  readTypes,
  SURVEY_FIELDS,
  SURVEY_SP_TITLE,
  TEMPLATE_FIELDS,
  TEMPLATE_SP_TITLE,
  SURVEY_SP_TITLES,
  TEMPLATE_SP_TITLES,
  planFieldOwnership,
  readFields,
  buildRenameTypeCall,
  buildTemplateFeaturesCall,
  buildCardSections,
  buildListSpFieldsCall,
  confirmsFieldOwnership,
  hasTemplateExtras,
  readTypeTitle,
  type ExistingField,
} from '../../server/domain/portals/smart-processes'

/**
 * Почти каждое утверждение здесь — про факт, подтверждённый на живом портале у соседнего
 * проекта и расходящийся с документацией. Ошибка в любом из них не ломает сборку: она
 * создаёт дубликат смарт-процесса при лимите тарифа или молча теряет поля.
 */

describe('имена и адреса полей', () => {
  it('поле создаётся под id ТИПА, а не под entityTypeId', () => {
    // Форма с entityTypeId отвергается порталом: «Вы не можете создавать пользовательские поля».
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
    // Переименование без прежнего названия в поиске = второй смарт-процесс на портале при
    // лимите 150. Названия и метка `[sh]` — решение владельца 28.09 (issue #84, пункт 22).
    expect([TEMPLATE_SP_TITLE, SURVEY_SP_TITLE]).toEqual(['[sh] Шаблон опроса', '[sh] Результат опросов'])
  })

  it('прежние названия узнаются поиском — иначе переустановка создаст второй смарт-процесс', () => {
    // Портал, обустроенный до ревизии 4, мог потерять наш идентификатор: переустановка
    // почистила `app.option`, а смарт-процесс остался со старым названием.
    const types = [{ id: 7, entityTypeId: 1044, title: 'Опрос' }]

    expect(findTypeByTitle(types, SURVEY_SP_TITLES)).toEqual({ entityTypeId: 1044, id: 7 })
    expect(findTypeByTitle([{ id: 9, entityTypeId: 1048, title: 'Шаблон опроса' }], TEMPLATE_SP_TITLES))
      .toEqual({ entityTypeId: 1048, id: 9 })
  })

  it('нынешнее название важнее прежнего, в каком бы порядке их ни отдал портал', () => {
    // Старый «Опрос» может оказаться чужим смарт-процессом клиента. Наш — тот, что с меткой.
    const types = [
      { id: 7, entityTypeId: 1044, title: 'Опрос' },
      { id: 8, entityTypeId: 1046, title: SURVEY_SP_TITLE },
    ]

    expect(findTypeByTitle(types, SURVEY_SP_TITLES)).toEqual({ entityTypeId: 1046, id: 8 })
  })

  it('не передаёт entityTypeId: его назначает портал', () => {
    // Документация подаёт это поле как выбор вызывающего, но выбранный номер
    // может быть занят на конкретном портале, а узнать это заранее нельзя.
    const call = buildCreateSmartProcessCall(SURVEY_SP_TITLE, 'survey')

    expect(JSON.stringify(call.params)).not.toContain('entityTypeId')
    expect(call.method).toBe('crm.type.add')
  })

  it('фиксирует состав флагов смарт-процесса целиком', () => {
    // Гвард из мутационного прогона на ревью PR #11: все шесть флагов можно было
    // перевернуть разом, и ни один тест не краснел. А каждый из них — решение:
    // выключенные стадии (состояние держим своим полем, чужие стадии переименуют),
    // включённый клиент (без него «Опрос» не привяжется к сделке и контакту),
    // включённые роботы (ради них всё и затевается). Сверяем объект целиком,
    // а не отсутствие одного ключа.
    expect(buildCreateSmartProcessCall(SURVEY_SP_TITLE, 'survey').params).toEqual({
      fields: {
        title: SURVEY_SP_TITLE,
        isStagesEnabled: false,
        isCategoriesEnabled: false,
        isClientEnabled: true,
        isAutomationEnabled: true,
        isBizProcEnabled: false,
        isRecyclebinEnabled: true,
      },
    })
  })

  it('«Шаблону» не даёт ни клиента, ни роботов', () => {
    // Решение владельца 28.09 (issue #84, пункт 19): на карточке шаблона лишние вкладки
    // и поля путают. Прежде оба смарт-процесса создавались одним вызовом.
    expect(buildCreateSmartProcessCall(TEMPLATE_SP_TITLE, 'template').params).toEqual({
      fields: {
        title: TEMPLATE_SP_TITLE,
        isStagesEnabled: false,
        isCategoriesEnabled: false,
        isClientEnabled: false,
        isAutomationEnabled: false,
        isBizProcEnabled: false,
        isRecyclebinEnabled: true,
      },
    })
  })

  it('поле создаётся закрытым от правки и с меткой владельца', () => {
    // Открытые поля позволяли вписать мусор в ответы клиента и опубликовать шаблон правкой
    // «Состояния» — владелец сделал это на живой проверке (issue #84, пункты 12 и 16).
    const field = buildCreateFieldCall(13, { postfix: 'CODE', userTypeId: 'string', label: 'Код шаблона' }).params.field as Record<string, unknown>

    expect(field.editInList).toBe('N')
    expect(field.editFormLabel).toEqual({ ru: '[sh] Код шаблона' })
  })

  it('у «Результата опросов» есть поле-ссылка на анкету', () => {
    // Решение владельца 28.09 (issue #84, пункт 20): адрес виден в карточке элемента.
    expect(SURVEY_FIELDS.find(f => f.postfix === 'LINK')).toMatchObject({ userTypeId: 'url' })
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

    expect(findTypeByTitle(types, ['Опрос'])).toEqual({ entityTypeId: 1044, id: 7 })
    expect(findTypeByTitle(types, ['Шаблон опроса'])).toBeNull()
  })

  it('не путает похожий заголовок', () => {
    // Иначе чужой «Опросник» стал бы нашим, и мы начали бы писать в него.
    expect(findTypeByTitle([{ id: 7, entityTypeId: 1044, title: 'Опросник' }], ['Опрос'])).toBeNull()
  })

  it('узнаёт заголовок с пробелами по краям', () => {
    // Гвард из мутационного прогона на ревью PR #11: снятие `.trim()` не краснило ничего.
    // Заголовок вводит человек, и хвостовой пробел сделал бы существующий смарт-процесс
    // «ненайденным» — мы создали бы дубликат при лимите 150 на весь портал.
    expect(findTypeByTitle([{ id: 7, entityTypeId: 1044, title: '  Опрос  ' }], ['Опрос']))
      .toEqual({ entityTypeId: 1044, id: 7 })
  })

  it('читает имена существующих полей', () => {
    const response = { result: { fields: [{ fieldName: 'UF_CRM_13_STATE' }, { noName: 1 }] } }

    expect(readFields(response).map(field => field.name)).toEqual(['UF_CRM_13_STATE'])
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
    expect(readFields({ result: {} })).toEqual([])
  })
})

describe('метка владельца и закрытые поля: разовая миграция (ревизия 4)', () => {
  const OURS = [
    { postfix: 'CODE', label: 'Код шаблона' },
    { postfix: 'SCHEMA', label: 'Схема анкеты (JSON)' },
  ]

  function field(overrides: Partial<ExistingField> & Pick<ExistingField, 'name'>): ExistingField {
    return { id: 5, userTypeId: 'string', editInList: 'Y', label: '', ...overrides }
  }

  function update(id: number, label: string) {
    return { method: 'userfieldconfig.update', params: { moduleId: 'crm', id, field: { editInList: 'N', editFormLabel: { ru: label } } } }
  }

  it('закрывает и помечает только своё и только то, что ещё не так', () => {
    const existing = [
      field({ id: 5, name: 'UF_CRM_8_CODE', label: 'Код шаблона' }),
      field({ id: 6, name: 'UF_CRM_8_SCHEMA', editInList: 'N', label: '[sh] Схема анкеты (JSON)' }),
      // Чужое поле клиента в нашем же смарт-процессе — его настройки не наши.
      field({ id: 7, name: 'UF_CRM_8_CLIENT_NOTE', label: 'Заметка' }),
    ]

    expect(planFieldOwnership(8, OURS, existing)).toEqual({ calls: [update(5, '[sh] Код шаблона')], unaddressable: [] })
  })

  it.each<[string, Partial<ExistingField>]>([
    ['закрыто, но подпись старая', { editInList: 'N', label: 'Код шаблона' }],
    ['подпись с меткой, но поле открыто', { editInList: 'Y', label: '[sh] Код шаблона' }],
    ['портал не сказал про флаг', { editInList: '', label: '[sh] Код шаблона' }],
  ])('правит поле, у которого сделана только половина (%s)', (_, half) => {
    // Гвард из мутационного прогона панели PR #87: условие пропуска «закрыто И помечено»
    // можно было заменить на «ИЛИ», и не краснело ничего — во всех фикстурах поле было либо
    // готово целиком, либо не тронуто вовсе. С «ИЛИ» закрытое поле со старой подписью метку
    // не получило бы никогда, а помеченное, но открытое осталось бы открытым.
    const existing = [field({ id: 5, name: 'UF_CRM_8_CODE', ...half })]

    expect(planFieldOwnership(8, OURS, existing).calls).toEqual([update(5, '[sh] Код шаблона')])
  })

  it('узнаёт своё поле в чужом написании имени', () => {
    // Гвард из мутационного прогона панели PR #87: без нормализации имени тесты оставались
    // зелёными, потому что все фикстуры были в каноничной форме. А `userfieldconfig.list`
    // отдаёт имя и слитно, и в camelCase — поле не нашлось бы и осталось открытым.
    const existing = [
      field({ id: 5, name: 'ufCrm8Code' }),
      field({ id: 6, name: 'UF_CRM8_SCHEMA' }),
    ]

    expect(planFieldOwnership(8, OURS, existing).calls).toEqual([
      update(5, '[sh] Код шаблона'),
      update(6, '[sh] Схема анкеты (JSON)'),
    ])
  })

  it('поле без идентификатора настроек называет — «не смогли» не выглядит как «нечего»', () => {
    // Молча пропустив такое поле, миграция отчиталась бы «всё закрыто» с открытым полем,
    // и ревизия отметилась бы навсегда. Нашли безопасность и `/review` в панели PR #87.
    const existing = [field({ id: 0, name: 'UF_CRM_8_CODE' })]

    expect(planFieldOwnership(8, OURS, existing)).toEqual({ calls: [], unaddressable: ['CODE'] })
  })

  it('готовое поле без идентификатора не считает незакрытым', () => {
    const existing = [field({ id: 0, name: 'UF_CRM_8_CODE', editInList: 'N', label: '[sh] Код шаблона' })]

    expect(planFieldOwnership(8, OURS, existing)).toEqual({ calls: [], unaddressable: [] })
  })

  it('читает из списка полей идентификатор, флаг правки и русскую подпись', () => {
    const response = { result: { fields: [{ id: '42', fieldName: 'UF_CRM_8_CODE', userTypeId: 'string', editInList: 'Y', editFormLabel: { ru: 'Код', en: 'Code' } }] } }

    expect(readFields(response)).toEqual([{ id: 42, name: 'UF_CRM_8_CODE', userTypeId: 'string', editInList: 'Y', label: 'Код' }])
  })

  it('без идентификатора настроек отдаёт ноль, а не NaN', () => {
    // Гвард из мутационного прогона панели PR #87: без проверки `id` тесты молчали, а `NaN`
    // не поймала бы защита `id === 0` в плане миграции — ушёл бы вызов на поле «NaN».
    const response = { result: { fields: [{ fieldName: 'UF_CRM_8_CODE', editInList: 'maybe' }] } }

    expect(readFields(response)).toEqual([{ id: 0, name: 'UF_CRM_8_CODE', userTypeId: '', editInList: '', label: '' }])
  })

  it('просит список полей с языком — без него подписей в ответе нет', () => {
    // Замерено 28.09: без `select.language` портал отдаёт поля без подписей, и миграция
    // переписывала бы каждое наше поле при каждом прогоне. Нашли `/review` и `/code-review`.
    expect(buildListSpFieldsCall(8)).toEqual({
      method: 'userfieldconfig.list',
      params: { moduleId: 'crm', select: { 0: '*', language: 'ru' }, filter: { entityId: 'CRM_8' } },
    })
    expect(buildListSpFieldsCall(8, 50).params).toMatchObject({ start: 50 })
  })

  it('верит закрытию только по ответу портала', () => {
    // Флаг методом не документирован: двухсотый ответ с открытым полем не должен считаться
    // успехом. Портал возвращает поле целиком — замерено 28.09.
    const sent = update(5, '[sh] Код шаблона')
    const echo = (field: Record<string, unknown> | null) => ({ result: { field } })

    expect(confirmsFieldOwnership(echo({ editInList: 'N', editFormLabel: { ru: '[sh] Код шаблона' } }), sent)).toBe(true)
    expect(confirmsFieldOwnership(echo({ editInList: 'Y', editFormLabel: { ru: '[sh] Код шаблона' } }), sent)).toBe(false)
    expect(confirmsFieldOwnership(echo({ editInList: 'N', editFormLabel: { ru: 'Код шаблона' } }), sent)).toBe(false)
    expect(confirmsFieldOwnership(echo(null), sent)).toBe(false)
    expect(confirmsFieldOwnership({ result: true }, sent)).toBe(false)
  })

  it('читает заголовок смарт-процесса по его id', () => {
    const types = [{ id: 8, title: '[sh] Шаблон опроса' }, { id: '10', title: 'Опрос' }]

    expect(readTypeTitle(types, 8)).toBe('[sh] Шаблон опроса')
    expect(readTypeTitle(types, 10)).toBe('Опрос')
    // Нет в списке — не «пустое название», а «не знаем»: переименовывать вслепую нельзя.
    expect(readTypeTitle(types, 99)).toBeNull()
  })

  it.each<[string, Record<string, unknown>, boolean | null]>([
    ['включён только клиент', { isClientEnabled: 'Y', isAutomationEnabled: 'N' }, true],
    ['включены только роботы', { isClientEnabled: 'N', isAutomationEnabled: 'Y' }, true],
    ['выключено оба', { isClientEnabled: 'N', isAutomationEnabled: 'N' }, false],
    ['флаги логическими значениями', { isClientEnabled: true, isAutomationEnabled: false }, true],
    ['флаг незнакомой формы', { isClientEnabled: 'N', isAutomationEnabled: 1 }, null],
  ])('видит, включено ли у «Шаблона» лишнее (%s)', (_, flags, expected) => {
    // Гвард из мутационного прогона панели PR #87: «ИЛИ» на «И» не краснило ничего — в фикстурах
    // оба флага всегда шли вместе. А незнакомая форма — «не знаем», а не «выключено»: иначе
    // включённые роботы остались бы включёнными молча.
    expect(hasTemplateExtras([{ id: 8, ...flags }], 8)).toBe(expected)
  })

  it('смарт-процесса нет в списке — лишнее не определено', () => {
    expect(hasTemplateExtras([{ id: 8, isClientEnabled: 'Y' }], 9)).toBeNull()
  })

  it('ищет по нынешнему названию первым, по прежнему — следом', () => {
    // Готовыми списками: искать надо и при обустройстве, и в операторских командах переноса,
    // и следующее переименование, дописанное в одно место, разошлось бы с другим.
    expect(TEMPLATE_SP_TITLES).toEqual(['[sh] Шаблон опроса', 'Шаблон опроса'])
    expect(SURVEY_SP_TITLES).toEqual(['[sh] Результат опросов', 'Опрос'])
  })

  it('переименование шлёт ТОЛЬКО название: связи, переданные в update, перезаписываются целиком', () => {
    expect(buildRenameTypeCall({ entityTypeId: 1040, id: 10 }, '[sh] Результат опросов')).toEqual({
      method: 'crm.type.update',
      params: { id: 10, fields: { title: '[sh] Результат опросов' } },
    })
  })

  it('у «Шаблона» выключаются ровно клиент и роботы', () => {
    expect(buildTemplateFeaturesCall({ entityTypeId: 1038, id: 8 })).toEqual({
      method: 'crm.type.update',
      params: { id: 8, fields: { isClientEnabled: 'N', isAutomationEnabled: 'N' } },
    })
  })

  it('ссылка на анкету стоит в карточке рядом со сроком действия', () => {
    const form = buildCardSections(10, true).find(section => section.name === 'survey_form')!

    expect(JSON.stringify(form.elements)).toContain('UF_CRM_10_LINK')
  })
})
