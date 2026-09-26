import { describe, expect, it, vi } from 'vitest'
import { ensureDealRelation, isPortalAdmin, provisionSmartProcesses, readStoredRefs, SP_REFS_OPTION, storeRefs, withDeadline } from '../../server/b24/provision'
import { buildCardSections, buildReadTypeCall, buildUpdateRelationsCall, DEAL_ENTITY_TYPE_ID, planDealRelation, readTypeRelations, SURVEY_FIELDS, TEMPLATE_FIELDS } from '../../server/domain/portals/smart-processes'
import { SURVEY_RESULT_TYPE } from '../../server/domain/portals/userfield-type'

/**
 * Обустройство портала целиком, поверх подделки вызова. Проверяем то, чья поломка
 * не видна в сборке: дубликат смарт-процесса при лимите тарифа 150 на портал
 * и молча потерянные поля.
 */

const TEMPLATE = { entityTypeId: 1044, id: 7 }
const SURVEY = { entityTypeId: 1046, id: 8 }

/** Что даёт `isClientEnabled` и только он: Контакт (3) и Компания (4). Сделки (2) тут нет. */
const CLIENT_ONLY = {
  parent: [
    { entityTypeId: 3, isChildrenListEnabled: 'Y', isPredefined: 'Y' },
    { entityTypeId: 4, isChildrenListEnabled: 'Y', isPredefined: 'Y' },
  ],
  child: [],
}

/** То же плюс Сделка — состояние, в котором приложение наконец работает. */
const WITH_DEAL = {
  parent: [...CLIENT_ONLY.parent, { entityTypeId: 2, isChildrenListEnabled: 'Y', isPredefined: 'N' }],
  child: [],
}

/** Подделка портала: отвечает по методу, считает вызовы. */
function portal(answers: Record<string, unknown | ((params: Record<string, unknown>) => unknown)> = {}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    const answer = answers[method]
    if (typeof answer === 'function') return (answer as (p: Record<string, unknown>) => unknown)(params)
    if (answer !== undefined) return answer
    // Умолчания: пустой портал, создание отвечает новыми идентификаторами.
    if (method === 'crm.type.list') return { result: { types: [] } }
    if (method === 'userfieldconfig.list') return { result: { fields: [] } }
    if (method === 'userfieldconfig.add') return { result: { field: 1 } }
    // Тип поля не зарегистрирован, приложение на портале под номером 219 — форма ответов
    // из документации `userfieldtype.list` и `app.info`.
    if (method === 'userfieldtype.list') return { result: [] }
    if (method === 'app.info') return { result: { ID: 219 } }
    // ⚠ Умолчание — смарт-процесс, СОЗДАННЫЙ С `isClientEnabled`: Контакт и Компания
    // стоят родителями и помечены `isPredefined`, а Сделки среди них НЕТ. Это не выдумка
    // подделки, а дословная форма ответа из документации `crm.type.get`, и именно это
    // состояние месяц стояло на живом портале.
    if (method === 'crm.type.get') return { result: { type: { relations: CLIENT_ONLY } } }
    // ⚠ Подделка ПРИМЕНЯЕТ присланное и отвечает так же, как живой портал: принимает флаг
    // как `'true'`/`'false'`, отдаёт как `'Y'`/`'N'`. Эта асимметрия — не придирка: именно
    // на ней связь со сделкой появилась, а список опросов в карточке остался выключенным.
    // Подделка, не воспроизводящая её, подтверждала бы что угодно.
    if (method === 'crm.type.update') {
      const sent = (params.fields as { relations?: { parent?: unknown[], child?: unknown[] } }).relations
      const applied = (list: unknown[] = []) => list.map((r) => {
        const { entityTypeId, isChildrenListEnabled } = r as Record<string, unknown>
        return { entityTypeId, isChildrenListEnabled: isChildrenListEnabled === 'true' ? 'Y' : 'N' }
      })
      return { result: { type: { relations: { parent: applied(sent?.parent), child: applied(sent?.child) } } } }
    }
    if (method === 'crm.type.add') {
      const title = (params.fields as { title?: string }).title
      const ref = title === 'Опрос' ? SURVEY : TEMPLATE
      return { result: { type: { id: ref.id, entityTypeId: ref.entityTypeId } } }
    }
    return { result: true }
  })
  return { call, calls, of: (method: string) => calls.filter(c => c.method === method) }
}

describe('права администратора', () => {
  it('признаёт только явное true', async () => {
    const yes = portal({ 'user.admin': { result: true } })
    const no = portal({ 'user.admin': { result: false } })
    // Портал может ответить строкой или пустотой — «не false» не равно «администратор».
    const odd = portal({ 'user.admin': { result: 'Y' } })

    expect(await isPortalAdmin(yes.call)).toBe(true)
    expect(await isPortalAdmin(no.call)).toBe(false)
    expect(await isPortalAdmin(odd.call)).toBe(false)
  })
})

describe('обустройство с нуля', () => {
  it('создаёт оба смарт-процесса и все поля', async () => {
    const p = portal()

    const result = await provisionSmartProcesses(p.call)

    expect(result.createdTemplate).toBe(true)
    expect(result.createdSurvey).toBe(true)
    expect(result.addedFields).toBe(TEMPLATE_FIELDS.length + SURVEY_FIELDS.length)
    expect(p.of('crm.type.add')).toHaveLength(2)
  })

  it('создаёт поля под id ТИПА, а не под entityTypeId', async () => {
    const p = portal()

    await provisionSmartProcesses(p.call)

    const entityIds = p.of('userfieldconfig.add').map(c => (c.params.field as { entityId: string }).entityId)
    expect(new Set(entityIds)).toEqual(new Set([`CRM_${TEMPLATE.id}`, `CRM_${SURVEY.id}`]))
  })

  it('падает, если портал не вернул идентификаторы', async () => {
    const p = portal({ 'crm.type.add': { result: {} } })

    await expect(provisionSmartProcesses(p.call)).rejects.toThrow(/не вернул идентификаторы/)
  })
})

describe('повторный запуск', () => {
  it('на готовом портале не делает ни одного изменяющего вызова', async () => {
    const existing = (params: Record<string, unknown>) => {
      const entityId = (params.filter as { entityId: string }).entityId
      const fields = entityId === `CRM_${TEMPLATE.id}` ? TEMPLATE_FIELDS : SURVEY_FIELDS
      const spId = entityId === `CRM_${TEMPLATE.id}` ? TEMPLATE.id : SURVEY.id
      return { result: { fields: fields.map(f => ({ fieldName: `UF_CRM_${spId}_${f.postfix}` })) } }
    }
    // ⚠ «Готовый» теперь значит и «связь со сделкой стоит». Без этой строки тест был бы
    // зелёным по неправильной причине: связь не читалась бы вовсе, и «ни одного изменяющего
    // вызова» означало бы «мы не дошли до того, чтобы что-то менять».
    const p = portal({ 'userfieldconfig.list': existing, 'crm.type.get': { result: { type: { relations: WITH_DEAL } } } })

    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY })

    expect(result.addedFields).toBe(0)
    expect(result.dealLinked).toBe(true)
    expect(p.of('crm.type.add')).toHaveLength(0)
    expect(p.of('userfieldconfig.add')).toHaveLength(0)
    expect(p.of('crm.type.update')).toHaveLength(0)
    // Список типов даже не запрашивается: оба идентификатора известны.
    expect(p.of('crm.type.list')).toHaveLength(0)
  })

  it('находит смарт-процесс по заголовку, когда идентификатор потерян', async () => {
    // Приложение переустановили, `app.option` почистили, смарт-процесс остался.
    // Без этого поиска мы создали бы второй и съели лимит тарифа.
    const p = portal({
      'crm.type.list': {
        result: {
          types: [
            { id: TEMPLATE.id, entityTypeId: TEMPLATE.entityTypeId, title: 'Шаблон опроса' },
            { id: SURVEY.id, entityTypeId: SURVEY.entityTypeId, title: 'Опрос' },
          ],
        },
      },
    })

    const result = await provisionSmartProcesses(p.call)

    expect(p.of('crm.type.add')).toHaveLength(0)
    expect(result.template).toEqual(TEMPLATE)
    expect(result.createdSurvey).toBe(false)
    // Найденное по заголовку помечается отдельно: заголовок не признак владения,
    // и вызывающий обязан оставить след в журнале — вдруг смарт-процесс чужой.
    expect([result.adoptedTemplate, result.adoptedSurvey]).toEqual([true, true])
  })

  it('не считает усыновлением ни созданное нами, ни известное по идентификатору', async () => {
    const fresh = await provisionSmartProcesses(portal().call)
    expect([fresh.adoptedTemplate, fresh.adoptedSurvey]).toEqual([false, false])

    const known = await provisionSmartProcesses(portal().call, { template: TEMPLATE, survey: SURVEY })
    expect([known.adoptedTemplate, known.adoptedSurvey]).toEqual([false, false])
  })

  it('до-лечивает частично созданный смарт-процесс', async () => {
    const p = portal({
      'userfieldconfig.list': (params: Record<string, unknown>) => {
        const entityId = (params.filter as { entityId: string }).entityId
        return entityId === `CRM_${SURVEY.id}`
          ? { result: { fields: [{ fieldName: `UF_CRM_${SURVEY.id}_STATE` }] } }
          : { result: { fields: [] } }
      },
    })

    const result = await provisionSmartProcesses(p.call)

    expect(result.addedFields).toBe(TEMPLATE_FIELDS.length + SURVEY_FIELDS.length - 1)
  })
})

/**
 * Гвард под дефект, из-за которого приложение месяц не делало того, ради чего написано.
 *
 * ⚠ У смарт-процесса поля `parentId2` не появляется само. `isClientEnabled` даёт Контакт
 * и Компанию — и ТОЛЬКО их, это дословно в документации `crm.type.update`. Сделка заводится
 * отдельно, через `relations.parent`. Пока шага не было, `crm.item.add` молча игнорировал
 * `parentId2`, элемент «Опрос» оставался без сделки, и итог не возвращался в карточку
 * НИКОГДА — притом что ответ доезжал, элемент обновлялся и всё выглядело работающим.
 *
 * Нашлось первым сквозным прогоном на живом портале: в журнале стояло `parentFields: []`.
 * Ни один тест поймать этого не мог — про связи не спрашивал ни один.
 */
/** Что реально ушло в портал — в его форме, не в нашей. */
function sentRelations(p: ReturnType<typeof portal>) {
  const fields = p.of('crm.type.update')[0]!.params.fields as { relations: { parent: { entityTypeId: number }[] } }
  return fields.relations
}

describe('связь «Опроса» со сделкой', () => {
  it('заводится там, где её нет', async () => {
    const p = portal()

    const result = await provisionSmartProcesses(p.call)

    expect(result.dealLinked).toBe(true)
    const update = p.of('crm.type.update')
    expect(update).toHaveLength(1)
    expect(update[0]!.params.id).toBe(SURVEY.id)
  })

  it('ДОПИСЫВАЕТСЯ к чужим связям, а не заменяет их', async () => {
    // ⚠ Главный тест файла. Документация `crm.type.update` про `relations`: «Настройки
    // необходимо передавать целиком, они полностью перезаписываются». Отправив один свой
    // пункт, мы стёрли бы Контакт и Компанию и любые связи, настроенные клиентом руками,
    // — то есть починка одной вещи сломала бы три чужих, причём тихо.
    const p = portal()

    await provisionSmartProcesses(p.call)

    const sent = sentRelations(p)
    expect(sent.parent.map(r => r.entityTypeId).sort()).toEqual([2, 3, 4])
  })

  it('шлёт флаг в той форме, которую портал ПРИНИМАЕТ, а не в той, которую отдаёт', () => {
    // ⚠ Живой портал: отправили `'Y'` — записалось `'N'`. Он отдаёт `'Y'`/`'N'`, а принимает
    // `'true'`/`'false'`; пример в документации `crm.type.add` шлёт именно `"true"`.
    // Из-за этой асимметрии связь со сделкой появилась, а список опросов в карточке — нет.
    const call = buildUpdateRelationsCall(SURVEY, { parent: [{ entityTypeId: 2, childrenList: true }], child: [] })
    const sent = (call.params.fields as { relations: { parent: Record<string, unknown>[] } }).relations

    expect(sent.parent[0]!.isChildrenListEnabled).toBe('true')
    expect(sent.parent[0]!.isChildrenListEnabled).not.toBe('Y')
  })

  it('заводится только «Опросу», не «Шаблону»', async () => {
    // Шаблон анкеты ни к какой сделке не относится: он про анкету, а не про прохождение.
    const p = portal()

    await provisionSmartProcesses(p.call)

    const touched = p.of('crm.type.update').map(c => c.params.id)
    expect(touched).toEqual([SURVEY.id])
  })

  it('не трогает настройки, когда связи не прочитались', async () => {
    // ⚠ Не узнав формы ответа, писать нельзя: `relations` перезаписываются целиком,
    // и «починка» вслепую стёрла бы клиенту всё. Лучше не починить, чем стереть.
    const p = portal({ 'crm.type.get': { result: true } })

    const result = await provisionSmartProcesses(p.call)

    expect(result.dealLinked).toBe(false)
    expect(p.of('crm.type.update')).toHaveLength(0)
  })

  it('не считает успехом двухсотый ответ без связи', async () => {
    // ⚠ Портал принял запрос и ничего не сделал — и мы отчитались бы об успехе ровно там,
    // где до этого молчали. Проверяем ОТВЕТ, а не отсутствие исключения.
    const p = portal({ 'crm.type.update': { result: { type: { relations: CLIENT_ONLY } } } })

    expect(await ensureDealRelation(p.call, SURVEY)).toBe(false)
  })

  it('тарифный отказ НЕ роняет установку', async () => {
    // ⚠ Гвард под находку панели: трое проверяющих независимо заметили, что вызов шёл без
    // `try/catch`, и `UPDATE_DYNAMIC_TYPE_RESTRICTED` (задокументированный код `crm.type.update`)
    // ронял ВСЮ установку. Идентификаторы не сохранялись, вкладка не регистрировалась,
    // а строка `logger.error` про ненастроенную связь не выполнялась никогда — при том что
    // собственный JSDoc обещал ровно обратное. Прежний тест назывался правильно и закреплял
    // противоположное поведение.
    const p = portal({
      'crm.type.update': () => {
        throw new Error('UPDATE_DYNAMIC_TYPE_RESTRICTED')
      },
    })

    const result = await provisionSmartProcesses(p.call)

    expect(result.dealLinked).toBe(false)
    // Остальное обустройство при этом доведено до конца.
    expect(result.addedFields).toBe(TEMPLATE_FIELDS.length + SURVEY_FIELDS.length)
  })
})

/**
 * Гвард под пробел, найденный панелью: раскладка карточки не была покрыта НИ ОДНИМ тестом.
 *
 * ⚠ Проверяющий сломал `hasCardConfig` (всегда «настройки нет») — и все 549 тестов остались
 * зелёными. То есть код, который на каждой переустановке переписывал бы клиенту раскладку
 * карточки для ВСЕХ пользователей, прошёл бы гейт незамеченным. Ровно тот класс отказа,
 * про который в проекте написано «все тесты зелёные при живой регрессии».
 */
describe('раскладка карточки «Опроса»', () => {
  it('ставится там, где своей нет', async () => {
    const p = portal()

    const result = await provisionSmartProcesses(p.call)

    expect(result.cardConfigured).toBe(true)
    const set = p.of('crm.item.details.configuration.set')
    expect(set).toHaveLength(1)
    expect(set[0]!.params.entityTypeId).toBe(SURVEY.entityTypeId)
    expect(set[0]!.params.scope).toBe('C')
  })

  it('НЕ трогает раскладку, которую настроил клиент', async () => {
    // ⚠ Метод перезаписывает раскладку целиком и сразу для всех пользователей. Клиент,
    // разложивший карточку под себя, получал бы нашу при каждой переустановке.
    const p = portal({
      'crm.item.details.configuration.get': { result: [{ name: 'своё', title: 'Своё', elements: [] }] },
    })

    const result = await provisionSmartProcesses(p.call)

    expect(result.cardConfigured).toBe(false)
    expect(p.of('crm.item.details.configuration.set')).toHaveLength(0)
  })

  it('показывает сделку и клиента, а не прячет их', async () => {
    // Ради этого раскладка и ставится: умолчание портала клало «Сделку» и «Клиента»
    // в «Скрытые поля», и карточка не отвечала ни «по какой сделке», ни «кого спрашивали».
    const sections = buildCardSections(SURVEY.id, true)
    const shown = sections.flatMap(s => (s.elements as { name: string, optionFlags?: number }[]))

    for (const name of ['PARENT_ID_2', 'CONTACT_ID', 'COMPANY_ID']) {
      const field = shown.find(e => e.name === name)
      expect(field, name).toBeDefined()
      // `optionFlags: 1` — «показывать всегда»: пустое место на виду говорит, что связи нет,
      // а спрятанное поле не говорит ничего.
      expect(field!.optionFlags, name).toBe(1)
    }
  })

  it('отказ раскладки не роняет установку', async () => {
    const p = portal({
      'crm.item.details.configuration.set': () => {
        throw new Error('ACCESS_DENIED')
      },
    })

    const result = await provisionSmartProcesses(p.call)

    expect(result.cardConfigured).toBe(false)
    expect(result.dealLinked).toBe(true)
  })
})

/**
 * Поле своего типа «Результат опроса» — виджет вместо двух JSON-полей в карточке «Опроса».
 *
 * ⚠ Первая редакция меняла адрес обработчика через `userfieldtype.delete` + `add` — по образцу
 * вкладок, где снятие безвредно. У типа поля так нельзя: на нём висят поля в карточках клиента,
 * а что с ними делает удаление типа, документация не говорит. Нашлось при сверке с документацией
 * до первого выката: у метода правки `HANDLER` есть прямым текстом. Отсюда гвард ниже.
 */
describe('поле «Результат опроса»', () => {
  const HANDLER = 'https://polls.example/uf/survey-result'
  const FIELD = `UF_CRM_${SURVEY.id}_RESULT`

  /** Раскладка, которую обустройство отправило в портал, — именами полей. */
  function sentLayout(p: ReturnType<typeof portal>): string[] {
    const data = p.of('crm.item.details.configuration.set')[0]!.params.data as { elements: { name: string }[] }[]
    return data.flatMap(section => section.elements.map(element => element.name))
  }

  /** Создание именно нашего поля — среди прочих `userfieldconfig.add`. */
  function resultFieldAdds(p: ReturnType<typeof portal>) {
    return p.of('userfieldconfig.add').filter(c => (c.params.field as { fieldName: string }).fieldName === FIELD)
  }

  it('на чистом портале: тип, полный код, поле — и виджет в раскладке вместо JSON', async () => {
    const p = portal()

    const result = await provisionSmartProcesses(p.call, {}, HANDLER)

    expect(result.resultField).toBe(true)
    expect(p.of('userfieldtype.add')[0]!.params.HANDLER).toBe(HANDLER)
    // Поле — по ПОЛНОМУ коду: короткий портал не примет («Invalid custom type specified»).
    expect((resultFieldAdds(p)[0]!.params.field as { userTypeId: string }).userTypeId).toBe(`rest_219_${SURVEY_RESULT_TYPE}`)
    expect(sentLayout(p)).toContain(FIELD)
    expect(sentLayout(p)).not.toContain(`UF_CRM_${SURVEY.id}_ANSWERS`)
  })

  it('поле заводится ДО раскладки карточки', async () => {
    // ⚠ Раскладка ставит в карточку имена полей. Поставив туда поле, которого ещё нет,
    // мы полагались бы на неописанное поведение портала с несуществующим именем.
    const p = portal()

    await provisionSmartProcesses(p.call, {}, HANDLER)

    const order = p.calls.map(c => c.method)
    const fieldAt = p.calls.findIndex(c => c.method === 'userfieldconfig.add' && (c.params.field as { fieldName: string }).fieldName === FIELD)
    expect(fieldAt).toBeGreaterThan(-1)
    expect(fieldAt).toBeLessThan(order.indexOf('crm.item.details.configuration.set'))
  })

  it('НИКОГДА не снимает тип — адрес меняет правкой', async () => {
    const p = portal({
      'userfieldtype.list': { result: [{ USER_TYPE_ID: SURVEY_RESULT_TYPE, HANDLER: 'https://old.example/uf/survey-result' }] },
    })

    await provisionSmartProcesses(p.call, {}, HANDLER)

    expect(p.of('userfieldtype.delete')).toHaveLength(0)
    expect(p.of('userfieldtype.add')).toHaveLength(0)
    expect(p.of('userfieldtype.update')[0]!.params.HANDLER).toBe(HANDLER)
  })

  it('повторное обустройство ничего не пишет: тип на месте, поле на месте', async () => {
    const p = portal({
      'userfieldtype.list': { result: [{ USER_TYPE_ID: SURVEY_RESULT_TYPE, HANDLER }] },
      'userfieldconfig.list': { result: { fields: [{ fieldName: FIELD }] } },
    })

    const result = await provisionSmartProcesses(p.call, {}, HANDLER)

    expect(result.resultField).toBe(true)
    expect(p.of('userfieldtype.add')).toHaveLength(0)
    expect(p.of('userfieldtype.update')).toHaveLength(0)
    expect(resultFieldAdds(p)).toHaveLength(0)
  })

  it('отказ регистрации установку не роняет, а карточка остаётся при JSON', async () => {
    // Карточка без ответов хуже простыни: ставить в неё поле, которого нет, нельзя.
    const p = portal({
      'userfieldtype.add': () => {
        throw new Error('ACCESS_DENIED')
      },
    })

    const result = await provisionSmartProcesses(p.call, {}, HANDLER)

    expect(result.resultField).toBe(false)
    expect(result.dealLinked).toBe(true)
    expect(resultFieldAdds(p)).toHaveLength(0)
    expect(sentLayout(p)).toContain(`UF_CRM_${SURVEY.id}_ANSWERS`)
    expect(sentLayout(p)).not.toContain(FIELD)
  })

  it('без идентификатора приложения поле не заводит', async () => {
    // Собрать полный код не из чего, а угадывать его мы не будем.
    const p = portal({ 'app.info': { result: {} } })

    const result = await provisionSmartProcesses(p.call, {}, HANDLER)

    expect(result.resultField).toBe(false)
    expect(resultFieldAdds(p)).toHaveLength(0)
  })

  it('без адреса обработчика шаг не делается вовсе', async () => {
    // Хост не `https` — регистрация честно не состоится, как у вкладок.
    const p = portal()

    const result = await provisionSmartProcesses(p.call, {}, null)

    expect(result.resultField).toBe(false)
    expect(p.of('userfieldtype.list')).toHaveLength(0)
  })

  it('ставит виджет в раскладку, которую приложение поставило раньше', async () => {
    // ⚠ Ради установленных порталов: раскладку целиком мы ставим только на пустом месте,
    // и без этого шага виджет у них не появился бы никогда (тот же класс, что issue #75).
    const p = portal({
      'crm.item.details.configuration.get': {
        result: buildCardSections(SURVEY.id, false),
      },
    })

    const result = await provisionSmartProcesses(p.call, {}, HANDLER)

    expect(result.cardConfigured).toBe(true)
    expect(sentLayout(p)).toContain(FIELD)
    expect(sentLayout(p)).not.toContain(`UF_CRM_${SURVEY.id}_SCORES`)
  })

  it('чужую раскладку без нашего раздела не трогает и ради виджета', async () => {
    const p = portal({
      'crm.item.details.configuration.get': { result: [{ name: 'своё', title: 'Своё', elements: [] }] },
    })

    await provisionSmartProcesses(p.call, {}, HANDLER)

    expect(p.of('crm.item.details.configuration.set')).toHaveLength(0)
  })
})

describe('планирование связи, без портала', () => {
  it('не планирует ничего, когда сделка уже в родителях', () => {
    // Идемпотентность: повторная установка не должна писать настройки заново.
    expect(planDealRelation(readTypeRelations({ result: { type: { relations: WITH_DEAL } } }))).toBeNull()
  })

  it('читает тип по `id`, а не по `entityTypeId`', () => {
    // ⚠ Проект уже обжигался на этой паре: `entityTypeId` адресует элементы, `id` — настройки.
    // Подделка портала отвечает по имени метода и на параметры не смотрит, поэтому подмена
    // здесь не поймалась бы ничем. Нашла панель ревью.
    expect(buildReadTypeCall(SURVEY).params.id).toBe(SURVEY.id)
    expect(buildReadTypeCall(SURVEY).params.id).not.toBe(SURVEY.entityTypeId)
  })

  it('не планирует ничего, когда читать было нечего', () => {
    expect(planDealRelation(null)).toBeNull()
    expect(readTypeRelations({ result: { type: {} } })).toBeNull()
    expect(readTypeRelations(null)).toBeNull()
  })

  it('роняет `isPredefined` и не шлёт его обратно', () => {
    // Это пометка портала о том, что связь появилась из `isClientEnabled`, а не наша
    // настройка. Отправлять обратно чужую пометку как свою — способ получить то, чего
    // не просили.
    const planned = planDealRelation(readTypeRelations({ result: { type: { relations: CLIENT_ONLY } } }))

    expect(JSON.stringify(planned)).not.toContain('isPredefined')
  })

  it('включает список детей в карточке сделки', () => {
    // Без него менеджер видит результат только комментарием, а перечитать прошлые анкеты
    // по сделке ему негде.
    const planned = planDealRelation(readTypeRelations({ result: { type: { relations: CLIENT_ONLY } } }))
    const deal = planned!.parent.find(r => r.entityTypeId === DEAL_ENTITY_TYPE_ID)

    expect(deal!.childrenList).toBe(true)
  })

  it('НЕ пишет ничего, если хоть одна связь не разобралась', () => {
    // ⚠ ГВАРД ПОД ДЕФЕКТ, КОТОРЫЙ УЖЕ БЫЛ В ПРОДЕ. `crm.type.update` перезаписывает
    // `relations` целиком, а прежняя редакция роняла непонятную запись через `filter` —
    // то есть связь, настроенную клиентом руками и нами не узнанную, стирал ровно тот вызов,
    // чей смысл «ничего не потерять». Правило модуля для нечитаемого ОТВЕТА было верным
    // с самого начала; теперь так же ведёт себя и нечитаемая ЗАПИСЬ.
    const withJunk = {
      parent: [{ entityTypeId: 'не число', isChildrenListEnabled: 'Y' }, { entityTypeId: 177, isChildrenListEnabled: 'Y' }],
      child: [],
    }

    expect(readTypeRelations({ result: { type: { relations: withJunk } } })).toBeNull()
    expect(planDealRelation(readTypeRelations({ result: { type: { relations: withJunk } } }))).toBeNull()
  })

  it('непонятная запись среди ДЕТЕЙ тоже отменяет запись', () => {
    // Отправляются оба списка целиком, значит и потерять можно из обоих.
    const withJunk = { parent: [{ entityTypeId: 2, isChildrenListEnabled: 'Y' }], child: [{ entityTypeId: 0 }] }

    expect(readTypeRelations({ result: { type: { relations: withJunk } } })).toBeNull()
  })

  it('чужая связь доезжает до записи целой', () => {
    // Смысл всей осторожности: связь, которую завёл клиент, должна пережить наше обустройство.
    const mine = { parent: [{ entityTypeId: 177, isChildrenListEnabled: 'Y' }], child: [] }
    const planned = planDealRelation(readTypeRelations({ result: { type: { relations: mine } } }))
    const params = buildUpdateRelationsCall(SURVEY, planned!).params.fields as { relations: { parent: Record<string, unknown>[] } }

    const theirs = params.relations.parent.find(r => r.entityTypeId === 177)
    expect(theirs).toBeDefined()
    expect(theirs!.isChildrenListEnabled).toBe('true')
  })

  it('читает наблюдавшиеся формы флага, и только их', () => {
    // Живой портал отдаёт строку `'Y'` или `'N'` — проверено `crm.type.get` 22.09.
    const read = (raw: unknown) => readTypeRelations({
      result: { type: { relations: { parent: [{ entityTypeId: 177, isChildrenListEnabled: raw }], child: [] } } },
    })

    expect(read('Y')!.parent[0]!.childrenList).toBe(true)
    expect(read('N')!.parent[0]!.childrenList).toBe(false)
  })

  it.each([['1'], ['y'], ['true'], [true], [undefined], ['может быть']])(
    'НЕ пишет ничего, когда флаг пришёл в форме %p', (raw) => {
      // ⚠ ГВАРД ПОД ВТОРУЮ РЕДАКЦИЮ ЭТОЙ ЖЕ ПРАВКИ. Первая останавливалась на непонятном
      // `entityTypeId`, а непонятный ФЛАГ молча превращала в «выключено» — и записывала его
      // обратно в портал как `'false'`. То есть ровно то стирание чужой настройки, против
      // которого вся правка и затевалась, просто на одно поле правее.
      const relations = { parent: [{ entityTypeId: 177, isChildrenListEnabled: raw }], child: [] }

      expect(readTypeRelations({ result: { type: { relations } } })).toBeNull()
    },
  )

  it.each([[true], [['2']], ['2'], [2.5], [null]])(
    'НЕ пишет ничего, когда `entityTypeId` пришёл как %p', (raw) => {
      // ⚠ Проверяем `typeof`, а не `Number()`. Приведение пропускало мусор сквозь гвард
      // и превращало его в ДРУГУЮ настоящую связь: `Number(true) === 1` — это Лид, `['2']` —
      // Сделка. Клиент получил бы связь, которой никогда не настраивал: это уже не потеря,
      // а порча. Живой портал отдаёт число.
      const relations = { parent: [{ entityTypeId: raw, isChildrenListEnabled: 'Y' }], child: [] }

      expect(readTypeRelations({ result: { type: { relations } } })).toBeNull()
    },
  )

  it('чинит выключенный список, а не считает связь готовой', () => {
    // ⚠ Гвард под вторую редакцию этого же места. Сверяя только `entityTypeId`, мы объявляли
    // связь готовой, и неправильно записанный флаг не вылечился бы НИКОГДА. Ровно это
    // и случилось на живом портале: связь появилась, список в сделке остался выключенным.
    const broken = { parent: [{ entityTypeId: 2, isChildrenListEnabled: 'N', isPredefined: 'N' }], child: [] }
    const planned = planDealRelation(readTypeRelations({ result: { type: { relations: broken } } }))

    expect(planned).not.toBeNull()
    expect(planned!.parent.filter(r => r.entityTypeId === 2)).toHaveLength(1)
    expect(planned!.parent[0]!.childrenList).toBe(true)
  })
})

describe('постраничные списки', () => {
  it('перелистывает типы, а не берёт первую страницу', async () => {
    // Наш смарт-процесс на второй странице иначе не нашёлся бы — и мы создали бы дубликат.
    const pages: Record<number, unknown> = {
      0: { result: { types: [{ id: 1, entityTypeId: 1030, title: 'Договоры' }] }, next: 50 },
      50: { result: { types: [{ id: SURVEY.id, entityTypeId: SURVEY.entityTypeId, title: 'Опрос' }] } },
    }
    const p = portal({ 'crm.type.list': (params: Record<string, unknown>) => pages[Number(params.start ?? 0)] })

    const result = await provisionSmartProcesses(p.call)

    expect(result.survey).toEqual(SURVEY)
    expect(result.createdSurvey).toBe(false)
    expect(p.of('crm.type.list')).toHaveLength(2)
  })

  it('перелистывает поля', async () => {
    const pages: Record<number, unknown> = {
      0: { result: { fields: [{ fieldName: `UF_CRM_${SURVEY.id}_STATE` }] }, next: 50 },
      50: { result: { fields: [{ fieldName: `UF_CRM_${SURVEY.id}_SCORE` }] } },
    }
    const p = portal({
      'userfieldconfig.list': (params: Record<string, unknown>) =>
        (params.filter as { entityId: string }).entityId === `CRM_${SURVEY.id}`
          ? pages[Number(params.start ?? 0)]
          : { result: { fields: [] } },
    })

    const result = await provisionSmartProcesses(p.call)

    expect(result.addedFields).toBe(TEMPLATE_FIELDS.length + SURVEY_FIELDS.length - 2)
  })
})

describe('отказ при создании поля', () => {
  it('пробует все поля, а не обрывается на первом упавшем', async () => {
    // У соседа цикл падал на первой ошибке, и поля из конца списка не создавались никогда.
    let seen = 0
    const p = portal({
      'userfieldconfig.add': () => {
        seen++
        if (seen === 1) throw new Error('нет прав')
        return { result: { field: 1 } }
      },
    })

    await expect(provisionSmartProcesses(p.call)).rejects.toThrow(/не создано полей: 1 из/)
    expect(p.of('userfieldconfig.add')).toHaveLength(TEMPLATE_FIELDS.length)
  })
})

describe('идентификаторы на портале', () => {
  it('читает сохранённые', async () => {
    const p = portal({ 'app.option.get': { result: JSON.stringify({ template: TEMPLATE, survey: SURVEY }) } })

    // ⚠ `revision: 0`, хотя в значении её нет вовсе, — и это несущее. Портал, обустроенный
    // ДО появления отметки (issue #75), обязан выглядеть устаревшим, иначе фоновая донастройка
    // сочтёт свежими ровно тех клиентов, ради которых она и заведена.
    expect(await readStoredRefs(p.call)).toEqual({ template: TEMPLATE, survey: SURVEY, revision: 0 })
  })

  it.each<[unknown, string]>([
    [{ result: null }, 'ничего не сохранено'],
    [{ result: 'не json' }, 'испорченное значение'],
    [{ result: JSON.stringify({ template: { entityTypeId: 0, id: 0 } }) }, 'нули вместо идентификаторов'],
  ])('не падает на негодном значении (%#: %s)', async (answer) => {
    const p = portal({ 'app.option.get': answer })

    // Не прочитали — найдём смарт-процессы по заголовку и перезапишем. Установка не должна
    // спотыкаться о собственную настройку.
    expect(await readStoredRefs(p.call)).toEqual({ template: undefined, survey: undefined, revision: 0 })
  })

  it('ГЛАВНОЕ: ревизия читается числом, а неизвестная — нулём (issue #75)', async () => {
    // ⚠ Отметка говорит, ЧЕМ настроен портал. Прочитав её слишком щедро, мы объявили бы
    // настроенными порталы, до которых новая настройка не доезжала, — то есть закрыли бы
    // дыру видимостью. Ноль здесь означает «настраивали давно или не настраивали вовсе».
    const ok = portal({ 'app.option.get': { result: JSON.stringify({ template: TEMPLATE, survey: SURVEY, revision: 2 }) } })
    expect((await readStoredRefs(ok.call)).revision).toBe(2)

    for (const junk of ['0', 'два', '-1', '', null]) {
      const p = portal({ 'app.option.get': { result: JSON.stringify({ template: TEMPLATE, survey: SURVEY, revision: junk }) } })
      expect((await readStoredRefs(p.call)).revision).toBe(0)
    }
  })

  it('пишет одним ключом', async () => {
    const p = portal()

    await storeRefs(p.call, { template: TEMPLATE, survey: SURVEY })

    const written = p.of('app.option.set')[0]!.params.options as Record<string, string>
    expect(JSON.parse(written[SP_REFS_OPTION]!)).toEqual({ template: TEMPLATE, survey: SURVEY })
  })
})

describe('общий бюджет времени', () => {
  it('пропускает вызовы, пока бюджет не исчерпан', async () => {
    const p = portal()
    const call = withDeadline(p.call, 1000, () => 0)

    await provisionSmartProcesses(call)

    expect(p.of('crm.type.add')).toHaveLength(2)
  })

  it('останавливает цепочку, а не просто перестаёт ждать ответа', async () => {
    // Холодная установка — 17–19 вызовов подряд под троттлингом SDK. Предел на один
    // вызов такую цепочку не ограничивает: важно, что бюджет проверяется ПЕРЕД вызовом
    // и портал перестаёт получать запросы, а не что мы отвернулись от ответа.
    const p = portal()
    let clock = 0
    const call = withDeadline(p.call, 50, () => clock)

    clock = 50
    await expect(provisionSmartProcesses(call)).rejects.toThrow(/общему пределу 50 мс/)
    expect(p.calls).toHaveLength(0)
  })

  it('исчерпание бюджета на середине не делает лишних вызовов', async () => {
    const p = portal()
    let clock = 0
    // Бюджета хватает ровно на два вызова: время идёт на каждом обращении к часам.
    const call = withDeadline(p.call, 3, () => clock++)

    await expect(provisionSmartProcesses(call)).rejects.toThrow(/обустройство прервано/)
    expect(p.calls.length).toBeLessThan(TEMPLATE_FIELDS.length + SURVEY_FIELDS.length)
  })
})
