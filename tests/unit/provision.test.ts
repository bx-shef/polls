import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureDealRelation, isPortalAdmin, provisionSmartProcesses, reachedRevision, readStoredRefs, SP_REFS_OPTION, storeRefs, withDeadline } from '../../server/b24/provision'
import { buildCardSections, buildReadTypeCall, buildUpdateRelationsCall, DEAL_ENTITY_TYPE_ID, planDealRelation, OWNERSHIP_REVISION, PROVISION_REVISION, readTypeRelations, SURVEY_FIELDS, SURVEY_SP_TITLE, TEMPLATE_FIELDS } from '../../server/domain/portals/smart-processes'
import { PortalError } from '../../server/domain/portals/portal-error'
import { SURVEY_RESULT_TYPE } from '../../server/domain/portals/userfield-type'
import { logger } from '../../server/utils/logger'

afterEach(() => {
  vi.restoreAllMocks()
})

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
    // Живой портал отвечает на правку поля самим полем — с тем, что записал (замерено 28.09).
    // Миграция ревизии 4 верит закрытию только по этому ответу, поэтому подделка отвечает так же.
    if (method === 'userfieldconfig.update') return { result: { field: { id: params.id, ...(params.field as object) } } }
    // Тип поля не зарегистрирован, приложение на портале под номером 219 — форма ответов
    // из документации `userfieldtype.list` и `app.info`.
    if (method === 'userfieldtype.list') return { result: [] }
    if (method === 'app.info') return { result: { ID: 219, INSTALLED: true } }
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
      const ref = title === SURVEY_SP_TITLE ? SURVEY : TEMPLATE
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

    // «Готовый» — это и текущая ревизия: разовая миграция ревизии 4 здесь уже позади.
    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY }, { previousRevision: PROVISION_REVISION })

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
describe('раскладка карточки «Результата опросов»', () => {
  it('ставится там, где своей нет', async () => {
    const p = portal()

    const result = await provisionSmartProcesses(p.call)

    expect(result.cardConfigured).toBe(true)
    const set = p.of('crm.item.details.configuration.set')
    expect(set).toHaveLength(1)
    expect(set[0]!.params.entityTypeId).toBe(SURVEY.entityTypeId)
    expect(set[0]!.params.scope).toBe('C')
  })

  it('ГЛАВНОЕ: раскладку клиента не заменяет своей — только ставит в неё свои поля, и разово', async () => {
    // ⚠ Метод перезаписывает раскладку целиком и сразу для всех пользователей. Клиент,
    // разложивший карточку под себя, получал бы нашу при каждой переустановке. С ревизии 6 (#84,
    // п. 15, решение владельца) в его раскладку встают только наши поля — один раз, при переходе.
    const own = [{ type: 'section', name: 'своё', title: 'Своё', elements: [{ name: 'OPPORTUNITY' }] }]
    const upgrading = portal({ 'crm.item.details.configuration.get': { result: own } })
    const settled = portal({ 'crm.item.details.configuration.get': { result: own } })

    await provisionSmartProcesses(upgrading.call, {}, { previousRevision: 5 })
    const result = await provisionSmartProcesses(settled.call, {}, { previousRevision: 6 })

    expect(upgrading.of('crm.item.details.configuration.set').map(one => one.params.data)).toEqual([
      [{ type: 'section', name: 'своё', title: 'Своё', elements: [{ name: 'OPPORTUNITY' }, { name: `UF_CRM_${SURVEY.id}_LINK` }] }],
    ])
    expect(result.cardConfigured).toBe(false)
    expect(settled.of('crm.item.details.configuration.set')).toHaveLength(0)
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

  it('отказ раскладки не роняет установку — и, неповторимый, ревизию не держит', async () => {
    const p = portal({
      'crm.item.details.configuration.set': () => {
        throw new PortalError('ACCESS_DENIED', 'Доступ запрещён')
      },
    })

    const result = await provisionSmartProcesses(p.call)

    expect(result.cardConfigured).toBe(false)
    expect(result.dealLinked).toBe(true)
    // Держи его ревизия, портал обустраивался бы каждый час впустую: права повтором не лечатся.
    expect(result.cardSettled).toBe(true)
  })
})

/**
 * Поле своего типа «Результат опроса» — виджет вместо JSON-полей в карточке «Результата опросов».
 *
 * ⚠ Первая редакция меняла адрес обработчика через `userfieldtype.delete` + `add` — по образцу
 * вкладок, где снятие безвредно. У типа поля так нельзя: на нём висят поля в карточках клиента,
 * а что с ними делает удаление типа, документация не говорит. Нашлось при сверке с документацией
 * до первого выката: у метода правки `HANDLER` есть прямым текстом. Отсюда гвард ниже.
 *
 * ⚠ Остальные гварды блока — находки панели ревью PR #80: поле до `installFinish`, чужое поле
 * с нашим именем, повтор правки раскладки у клиента, который убрал виджет сам.
 */
describe('поле «Результат опроса»', () => {
  const HANDLER = 'https://polls.example/uf/survey-result'
  const FIELD = `UF_CRM_${SURVEY.id}_RESULT`
  const OUR_TYPE = `rest_219_${SURVEY_RESULT_TYPE}`
  const WITH_WIDGET = { resultHandlerUrl: HANDLER }

  /** Раскладка, которую обустройство отправило в портал, — именами полей. */
  function sentLayout(p: ReturnType<typeof portal>): string[] {
    const data = p.of('crm.item.details.configuration.set')[0]!.params.data as { elements: { name: string }[] }[]
    return data.flatMap(section => section.elements.map(element => element.name))
  }

  /** Создание именно нашего поля — среди прочих `userfieldconfig.add`. */
  function resultFieldAdds(p: ReturnType<typeof portal>) {
    return p.of('userfieldconfig.add').filter(c => (c.params.field as { fieldName: string }).fieldName === FIELD)
  }

  /** Поле виджета уже стоит на «Опросе» — с таким типом. */
  function withField(userTypeId: string) {
    return {
      'userfieldconfig.list': (params: Record<string, unknown>) =>
        (params.filter as { entityId: string }).entityId === `CRM_${SURVEY.id}`
          ? { result: { fields: [{ fieldName: FIELD, userTypeId }] } }
          : { result: { fields: [] } },
    }
  }

  it('на чистом портале: тип, полный код, поле — и виджет в раскладке вместо JSON', async () => {
    const p = portal()

    const result = await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(result.resultField).toBe('ok')
    expect(p.of('userfieldtype.add')[0]!.params.HANDLER).toBe(HANDLER)
    // Поле — по ПОЛНОМУ коду: короткий портал не примет («Invalid custom type specified»).
    expect((resultFieldAdds(p)[0]!.params.field as { userTypeId: string }).userTypeId).toBe(OUR_TYPE)
    // Виджет живьём показал результат (владелец, 28.09) — JSON в карточке больше не нужен (#81, шаг 2).
    const layout = sentLayout(p)
    expect(layout).toContain(FIELD)
    expect(layout).not.toContain(`UF_CRM_${SURVEY.id}_ANSWERS`)
  })

  it('поле заводится ДО раскладки карточки', async () => {
    // ⚠ Раскладка ставит в карточку имена полей. Поставив туда поле, которого ещё нет,
    // мы полагались бы на неописанное поведение портала с несуществующим именем.
    const p = portal()

    await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    const order = p.calls.map(c => c.method)
    const fieldAt = p.calls.findIndex(c => c.method === 'userfieldconfig.add' && (c.params.field as { fieldName: string }).fieldName === FIELD)
    expect(fieldAt).toBeGreaterThan(-1)
    expect(fieldAt).toBeLessThan(order.indexOf('crm.item.details.configuration.set'))
  })

  it('ГЛАВНОЕ: до `installFinish` ничего не регистрирует и откладывает шаг', async () => {
    // ⚠ Мастер установки обустраивает портал ДО `installFinish()`, а поле своего типа портал
    // до него не примет. Первая редакция `INSTALLED` не смотрела, и на каждом портале из Маркета
    // виджет не появился бы никогда. Нашли `/review` и `/code-review`.
    const p = portal({ 'app.info': { result: { ID: 219, INSTALLED: false } } })

    const result = await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(result.resultField).toBe('deferred')
    expect(p.of('userfieldtype.add')).toHaveLength(0)
    expect(resultFieldAdds(p)).toHaveLength(0)
    expect(sentLayout(p)).not.toContain(FIELD)
    // Остальная установка идёт как шла.
    expect(result.dealLinked).toBe(true)
  })

  it('НИКОГДА не снимает тип — адрес меняет правкой', async () => {
    const p = portal({
      'userfieldtype.list': { result: [{ USER_TYPE_ID: SURVEY_RESULT_TYPE, HANDLER: 'https://old.example/uf/survey-result' }] },
    })

    await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(p.of('userfieldtype.delete')).toHaveLength(0)
    expect(p.of('userfieldtype.add')).toHaveLength(0)
    expect(p.of('userfieldtype.update')[0]!.params.HANDLER).toBe(HANDLER)
  })

  it('тип и поле на месте — не регистрирует и не создаёт их заново', async () => {
    const p = portal({
      'userfieldtype.list': { result: [{ USER_TYPE_ID: SURVEY_RESULT_TYPE, HANDLER }] },
      ...withField(OUR_TYPE),
    })

    const result = await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(result.resultField).toBe('ok')
    expect(p.of('userfieldtype.add')).toHaveLength(0)
    expect(p.of('userfieldtype.update')).toHaveLength(0)
    expect(resultFieldAdds(p)).toHaveLength(0)
  })

  it('поле с нашим именем, но чужого типа — не трогает и виджет не ставит', async () => {
    // ⚠ Так бывает у «усыновлённого» смарт-процесса (строковое поле клиента) и после
    // переустановки (наш тип со старым идентификатором приложения). Удалять нельзя: в клиентском
    // поле могут быть данные. Нашли `/review` и `/code-review`.
    const p = portal(withField('string'))

    const result = await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(result.resultField).toBe('failed')
    expect(p.of('userfieldconfig.delete')).toHaveLength(0)
    expect(resultFieldAdds(p)).toHaveLength(0)
    expect(sentLayout(p)).not.toContain(FIELD)
  })

  it.each<[string, Record<string, unknown>]>([
    ['регистрация типа', { 'userfieldtype.add': () => { throw new Error('ACCESS_DENIED') } }],
    ['правка адреса', {
      'userfieldtype.list': { result: [{ USER_TYPE_ID: SURVEY_RESULT_TYPE, HANDLER: 'https://old.example/x' }] },
      'userfieldtype.update': () => { throw new Error('ERROR_CORE') },
    }],
    ['создание поля', {
      'userfieldconfig.add': (params: Record<string, unknown>) => {
        if ((params.field as { fieldName: string }).fieldName === FIELD) throw new Error('Invalid custom type specified')
        return { result: { field: 1 } }
      },
    }],
  ])('отказ на шаге «%s» установку не роняет, а виджета в раскладке нет', async (_step, answers) => {
    // Ставить в карточку поле, которого нет, нельзя: пустое место вместо виджета хуже простыни.
    const p = portal(answers)

    const result = await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(result.resultField).toBe('failed')
    expect(result.dealLinked).toBe(true)
    expect(sentLayout(p)).toContain(`UF_CRM_${SURVEY.id}_ANSWERS`)
    expect(sentLayout(p)).not.toContain(FIELD)
  })

  it('без идентификатора приложения поле не заводит', async () => {
    // Собрать полный код не из чего, а угадывать его мы не будем.
    const p = portal({ 'app.info': { result: { INSTALLED: true } } })

    const result = await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(result.resultField).toBe('failed')
    expect(resultFieldAdds(p)).toHaveLength(0)
  })

  it('без адреса обработчика шаг не делается вовсе', async () => {
    // Хост не `https` — регистрация честно не состоится, как у вкладок.
    const p = portal()

    const result = await provisionSmartProcesses(p.call, {}, { resultHandlerUrl: null })

    expect(result.resultField).toBe('failed')
    expect(p.of('app.info')).toHaveLength(0)
    expect(p.of('userfieldtype.list')).toHaveLength(0)
  })

  it('ставит виджет в раскладку, которую приложение поставило раньше, и убирает JSON', async () => {
    // ⚠ Ради установленных порталов: раскладку целиком мы ставим только на пустом месте,
    // и без этого шага виджет у них не появился бы никогда (тот же класс, что issue #75).
    const p = portal({
      'crm.item.details.configuration.get': { result: buildCardSections(SURVEY.id, false) },
    })

    const result = await provisionSmartProcesses(p.call, {}, { ...WITH_WIDGET, previousRevision: 2 })

    expect(result.cardConfigured).toBe(true)
    expect(sentLayout(p)).toContain(FIELD)
    expect(sentLayout(p)).not.toContain(`UF_CRM_${SURVEY.id}_SCORES`)
  })

  it('правка раскладки разовая: у портала на ревизии 6 её не повторяет', async () => {
    // ⚠ Клиент убрал виджет из карточки сам — следующее обустройство (переустановка, долечивание)
    // не должно возвращать его обратно для всех пользователей. Нашёл `/review`.
    const p = portal({
      'crm.item.details.configuration.get': { result: buildCardSections(SURVEY.id, false) },
      ...withField(OUR_TYPE),
    })

    await provisionSmartProcesses(p.call, {}, { ...WITH_WIDGET, previousRevision: 6 })

    expect(p.of('crm.item.details.configuration.set')).toHaveLength(0)
  })

  it('ГЛАВНОЕ: в чужую раскладку без наших полей виджет встаёт в первый раздел, а не в «Скрытые поля»', async () => {
    // Пересмотр решения PR #80 по слову владельца (#84, п. 15): прежде такая раскладка не трогалась
    // вовсе, и виджет у клиента не появлялся никогда.
    const p = portal({
      'crm.item.details.configuration.get': { result: [{ type: 'section', name: 'своё', title: 'Своё', elements: [] }] },
    })

    const result = await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(result.cardConfigured).toBe(true)
    expect(p.of('crm.item.details.configuration.set')[0]!.params.data).toEqual([
      { type: 'section', name: 'своё', title: 'Своё', elements: [{ name: FIELD, optionFlags: 1 }, { name: `UF_CRM_${SURVEY.id}_LINK` }] },
    ])
  })

  it('ГЛАВНОЕ: повторимый отказ разовой правки держит ревизию — иначе к карточке не вернулись бы', async () => {
    const p = portal({
      'crm.item.details.configuration.get': { result: buildCardSections(SURVEY.id, false) },
      'crm.item.details.configuration.set': () => {
        throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      },
    })

    const result = await provisionSmartProcesses(p.call, {}, { ...WITH_WIDGET, previousRevision: 5 })

    expect(result.cardSettled).toBe(false)
    expect(reachedRevision(5, result)).toBe(5)
  })

  it('ГЛАВНОЕ: повторимый отказ шага поля виджета тоже держит ревизию — без поля правка сняла бы не всё', async () => {
    // ⚠ Без поля виджета правка ставит одну ссылку, JSON остаётся, а ревизия 6 отметилась бы — и к
    // карточке мы не вернулись бы никогда. Нашли `/review` и `/code-review` в панели PR #98.
    const refusing = (code: string) => portal({
      'app.info': () => {
        throw new PortalError(code, 'отказ')
      },
      'crm.item.details.configuration.get': { result: buildCardSections(SURVEY.id, false) },
    })
    const retry = refusing('QUERY_LIMIT_EXCEEDED')
    const refused = refusing('ACCESS_DENIED')

    const held = await provisionSmartProcesses(retry.call, {}, { ...WITH_WIDGET, previousRevision: 5 })
    const settled = await provisionSmartProcesses(refused.call, {}, { ...WITH_WIDGET, previousRevision: 5 })

    expect([held.resultField, held.cardSettled, reachedRevision(5, held)]).toEqual(['failed', false, 5])
    expect([settled.resultField, settled.cardSettled]).toEqual(['failed', true])
  })

  it('ГЛАВНОЕ: на портале ревизии 6 повторимый отказ шага поля виджета ревизию не держит и не опускает', async () => {
    // ⚠ Без гейта `cardDue` у этой проверки портал, уже отмеченный шестой, при каждом сбое связи
    // опускался бы до пятой — и правка карточки повторилась бы, возвращая клиенту убранное им самим.
    // Нашли `/review` и `/code-review` в панели PR #98.
    const p = portal({
      'app.info': () => {
        throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      },
      'crm.item.details.configuration.get': { result: buildCardSections(SURVEY.id, true) },
    })

    const result = await provisionSmartProcesses(p.call, {}, { ...WITH_WIDGET, previousRevision: 6 })

    expect([result.resultField, result.cardSettled, reachedRevision(6, result)]).toEqual(['failed', true, 6])
    expect(p.of('crm.item.details.configuration.set')).toHaveLength(0)
  })

  it('на портале ревизии 6 повторимый отказ раскладки ревизию не держит — правка ему уже не положена', async () => {
    const p = portal({
      ...withField(OUR_TYPE),
      'crm.item.details.configuration.get': () => {
        throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      },
    })

    const result = await provisionSmartProcesses(p.call, {}, { ...WITH_WIDGET, previousRevision: 6 })

    expect(result.cardSettled).toBe(true)
    expect(reachedRevision(6, result)).toBe(6)
  })

  it('ГЛАВНОЕ: карточка уже на ревизии 6 — ни одной записи, хотя правка и положена', async () => {
    // Идемпотентность правки на сквозном пути: без неё донастройка писала бы раскладку каждый час,
    // пока портал держится ниже шестой. Нашёл тестировщик в панели PR #98.
    const p = portal({
      ...withField(OUR_TYPE),
      'crm.item.details.configuration.get': { result: buildCardSections(SURVEY.id, true) },
    })

    const result = await provisionSmartProcesses(p.call, {}, { ...WITH_WIDGET, previousRevision: 5 })

    expect(result.cardConfigured).toBe(false)
    expect(p.of('crm.item.details.configuration.set')).toHaveLength(0)
  })

  describe('усыновлённый смарт-процесс', () => {
    const ADOPTED = { template: TEMPLATE, survey: SURVEY, adopted: { survey: true as const } }
    const CLIENT_LAYOUT = [{ type: 'section', name: 'main', title: 'Мой опрос', elements: [{ name: 'TITLE' }] }]

    it('ГЛАВНОЕ: раскладку без единого нашего поля не трогает — это может быть «Опрос» клиента', async () => {
      // ⚠ Найденный по названию смарт-процесс может оказаться собственным процессом клиента, и наши
      // поля встали бы в его карточку у всех пользователей. Нашёл `/code-review` в панели PR #98.
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
      const p = portal({ 'crm.item.details.configuration.get': { result: CLIENT_LAYOUT } })

      const result = await provisionSmartProcesses(p.call, ADOPTED, { ...WITH_WIDGET, previousRevision: 5 })

      expect(result.adoptedSurvey).toBe(true)
      expect(p.of('crm.item.details.configuration.set')).toHaveLength(0)
      expect([result.cardConfigured, result.cardSettled]).toEqual([false, true])
      expect(info.mock.calls.some(([, message]) => String(message).includes('нет ни одного нашего поля'))).toBe(true)
    })

    it('ГЛАВНОЕ: свою раскладку доводит — наш же смарт-процесс после переустановки не замерзает', async () => {
      // ⚠ Первая редакция не трогала усыновлённого вовсе, а усыновляется чаще всего наш же,
      // переживший переустановку: ни виджета, ни ссылки у него не было бы никогда. Нашли `/review`
      // и `/code-review` в панели PR #98.
      const p = portal({ 'crm.item.details.configuration.get': { result: buildCardSections(SURVEY.id, false) } })

      const result = await provisionSmartProcesses(p.call, ADOPTED, { ...WITH_WIDGET, previousRevision: 5 })

      expect(result.cardConfigured).toBe(true)
      expect(sentLayout(p)).toContain(FIELD)
      expect(sentLayout(p)).not.toContain(`UF_CRM_${SURVEY.id}_ANSWERS`)
    })

    it('ГЛАВНОЕ: своей раскладки нет — нашу целиком не ставит', async () => {
      // Раскладка с нуля — это наши разделы у всех пользователей, а процесс может быть клиентским:
      // у него остаётся умолчание портала. Нашли `/review` и `/code-review` в панели PR #98.
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
      const p = portal()

      const result = await provisionSmartProcesses(p.call, ADOPTED, WITH_WIDGET)

      expect(p.of('crm.item.details.configuration.set')).toHaveLength(0)
      expect(result.cardConfigured).toBe(false)
      expect(info.mock.calls.some(([, message]) => String(message).includes('нашу целиком не ставим'))).toBe(true)
    })

    it('отказ шага поля виджета ради чужой раскладки ревизию не держит — её не тронем и потом', async () => {
      // Держа ревизию, портал обустраивался бы каждый час ради раскладки, которую мы не правим.
      const p = portal({
        'app.info': () => {
          throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        },
        'crm.item.details.configuration.get': { result: CLIENT_LAYOUT },
      })

      const result = await provisionSmartProcesses(p.call, ADOPTED, { ...WITH_WIDGET, previousRevision: 5 })

      expect([result.resultField, result.cardSettled]).toEqual(['failed', true])
    })
  })

  it('непонятную раскладку не пишет, но говорит об этом', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const p = portal({
      // Раздел, который `set` не принял бы: без названия. Разбор — у `readCardLayout`.
      'crm.item.details.configuration.get': { result: [{ type: 'section', name: 'своё', elements: [{ name: 'TITLE' }] }] },
    })

    await provisionSmartProcesses(p.call, {}, WITH_WIDGET)

    expect(p.of('crm.item.details.configuration.set')).toHaveLength(0)
    expect(warn.mock.calls.some(([, message]) => String(message).includes('непонятной формы'))).toBe(true)
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
    expect(await readStoredRefs(p.call)).toEqual({ template: TEMPLATE, survey: SURVEY, revision: 0, adopted: {} })
  })

  it.each<[unknown, string]>([
    [{ result: null }, 'ничего не сохранено'],
    [{ result: 'не json' }, 'испорченное значение'],
    [{ result: JSON.stringify({ template: { entityTypeId: 0, id: 0 } }) }, 'нули вместо идентификаторов'],
  ])('не падает на негодном значении (%#: %s)', async (answer) => {
    const p = portal({ 'app.option.get': answer })

    // Не прочитали — найдём смарт-процессы по заголовку и перезапишем. Установка не должна
    // спотыкаться о собственную настройку.
    expect(await readStoredRefs(p.call)).toEqual({ template: undefined, survey: undefined, revision: 0, adopted: {} })
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

    await storeRefs(p.call, { template: TEMPLATE, survey: SURVEY }, { revision: 0, adopted: {} })

    const written = p.of('app.option.set')[0]!.params.options as Record<string, string>
    expect(JSON.parse(written[SP_REFS_OPTION]!)).toEqual({ template: TEMPLATE, survey: SURVEY })
  })

  it('ГЛАВНОЕ: прежнюю ревизию не стирает', async () => {
    // Гвард под находку `/code-review` в PR #87. Идентификаторы и ревизия лежат в одной опции,
    // и запись без ревизии её стирала: портал ревизии 3, на котором не закрылись поля, следующим
    // прогоном читался как ревизия 0 — и разовая правка раскладки возвращала виджет в карточку
    // клиента, который его убрал.
    const p = portal()

    await storeRefs(p.call, { template: TEMPLATE, survey: SURVEY }, { revision: 3, adopted: {} })

    const written = p.of('app.option.set')[0]!.params.options as Record<string, string>
    expect(JSON.parse(written[SP_REFS_OPTION]!)).toEqual({ template: TEMPLATE, survey: SURVEY, revision: 3 })
  })

  it('ГЛАВНОЕ: помнит, какой смарт-процесс усыновлён', async () => {
    // Гвард под находку `/code-review` во втором круге PR #87: без признака в опции следующий
    // прогон считал усыновлённый смарт-процесс своим и переименовывал его.
    const p = portal()

    await storeRefs(p.call, { template: TEMPLATE, survey: SURVEY }, { revision: 0, adopted: { template: true } })

    const written = (p.of('app.option.set')[0]!.params.options as Record<string, string>)[SP_REFS_OPTION]!
    expect(JSON.parse(written)).toEqual({ template: TEMPLATE, survey: SURVEY, adopted: { template: true } })
    const back = portal({ 'app.option.get': { result: written } })
    expect((await readStoredRefs(back.call)).adopted).toEqual({ template: true })
  })

  const SETTLED = { changes: 0, settled: true }
  const UNSETTLED = { changes: 0, settled: false }

  it.each<[string, number, Parameters<typeof reachedRevision>[1], Parameters<typeof reachedRevision>[2], number]>([
    ['поле виджета отложено — ревизия прежняя', 2, { resultField: 'deferred', ownership: null, stages: SETTLED, cardSettled: true }, null, 2],
    ['миграция 4 не доделана — ревизия до неё', 2, { resultField: 'ok', ownership: { changes: 1, fieldsLocked: false, settled: true }, stages: SETTLED, cardSettled: true }, null, 3],
    ['не доделана, а портал уже выше — не опускаем', 3, { resultField: 'ok', ownership: { changes: 0, fieldsLocked: true, settled: false }, stages: SETTLED, cardSettled: true }, null, 3],
    ['всё доделано', 2, { resultField: 'ok', ownership: { changes: 5, fieldsLocked: true, settled: true }, stages: SETTLED, cardSettled: true }, SETTLED, 6],
    ['миграция не требовалась', 6, { resultField: 'failed', ownership: null, stages: SETTLED, cardSettled: true }, null, 6],
    // Ревизия 5: стадии и перенос старого поля. Повтор нужен — портал на ревизии до них, а не ниже.
    ['стадии не доделаны — ревизия до них', 4, { resultField: 'ok', ownership: null, stages: UNSETTLED, cardSettled: true }, SETTLED, 4],
    ['перенос «Состояния» не доделан — ревизия до него', 4, { resultField: 'ok', ownership: null, stages: SETTLED, cardSettled: true }, UNSETTLED, 4],
    ['миграция 4 и стадии разом — держит та, что раньше', 2, { resultField: 'ok', ownership: { changes: 0, fieldsLocked: false, settled: true }, stages: UNSETTLED, cardSettled: true }, null, 3],
    // ⚠ Портал уже на пятой, а смарт-процесс на нём пересоздан, и его воронка не прочиталась:
    // ревизия ОПУСКАЕТСЯ до четвёртой. С `max(previous, 4)` портал не вернулся бы к донастройке
    // никогда. Нашёл `/code-review` в панели PR #93; строку с шестой просил тестировщик.
    ['стадии не доделаны на портале пятой ревизии — опускаем до четвёртой', 5, { resultField: 'ok', ownership: null, stages: UNSETTLED, cardSettled: true }, null, 4],
    ['и выше пятой — тоже', 6, { resultField: 'ok', ownership: null, stages: UNSETTLED, cardSettled: true }, null, 4],
    // Ревизия 6: разовая правка карточки. Отказ, который лечится повтором, держит портал на пятой.
    ['карточка не доделана — ревизия до неё', 5, { resultField: 'ok', ownership: null, stages: SETTLED, cardSettled: false }, SETTLED, 5],
    ['стадии и карточка разом — держат стадии', 4, { resultField: 'ok', ownership: null, stages: UNSETTLED, cardSettled: false }, null, 4],
    // Строки «не доделана на портале шестой» здесь нет: такого входа не бывает — правку держит гейт
    // `cardDue`, и это доказывают сквозные тесты «на портале ревизии 6 …» в блоке поля виджета.
    // Нашёл `/review` в панели PR #98.
    ['карточка не доделана, всё прежнее доделано — ревизия пятая', 2, { resultField: 'ok', ownership: { changes: 3, fieldsLocked: true, settled: true }, stages: SETTLED, cardSettled: false }, SETTLED, 5],
  ])('достигнутая ревизия: %s', (_, previous, result, carried, expected) => {
    // Гвард под находки `/code-review` и `/review` во втором круге PR #87: ревизия откатывалась
    // к нулю, не поднималась до уже сделанного и считалась у вызывающего особым случаем.
    expect(reachedRevision(previous, result, carried)).toBe(expected)
  })

  it('признак усыновления читается только явным true', async () => {
    const p = portal({ 'app.option.get': { result: JSON.stringify({ template: TEMPLATE, survey: SURVEY, adopted: { template: 'yes', survey: 1 } }) } })

    expect((await readStoredRefs(p.call)).adopted).toEqual({})
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
    // Холодная установка — 53 вызова подряд под троттлингом SDK. Предел на один
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

/**
 * Разовая миграция ревизии 4: метка владельца и закрытые поля (issue #84, пункты 12, 16, 19, 22).
 *
 * ⚠ Гварды под находку живой проверки 28.09: владелец вписал мусор в ответы клиента и опубликовал
 * шаблон в обход проверок правкой открытых полей. Порталы, обустроенные раньше, сами этого
 * не получат — только миграцией.
 */
describe('ревизия 4: метка владельца и закрытые поля', () => {
  type Answers = Record<string, unknown | ((params: Record<string, unknown>) => unknown)>

  /** Наш тип поля на портале подделки: приложение под номером 219 (умолчание `app.info`). */
  const OUR_TYPE = `rest_219_${SURVEY_RESULT_TYPE}`

  /** Поля «Опроса» до ревизии 4: «Ссылки на анкету» ещё нет, поле виджета уже есть (ревизия 3). */
  const LEGACY_SURVEY_FIELDS = [
    ...SURVEY_FIELDS.filter(field => field.postfix !== 'LINK'),
    { postfix: 'RESULT', label: 'Результат опроса', userTypeId: OUR_TYPE },
  ]

  /** Поля, какими их оставила ревизия 3: открыты, подписи без метки. */
  function legacyFields(params: Record<string, unknown>) {
    const entityId = (params.filter as { entityId: string }).entityId
    const spId = entityId === `CRM_${TEMPLATE.id}` ? TEMPLATE.id : SURVEY.id
    const fields = spId === TEMPLATE.id ? TEMPLATE_FIELDS : LEGACY_SURVEY_FIELDS
    return {
      result: {
        fields: fields.map((f, i) => ({
          id: spId * 100 + i,
          fieldName: `UF_CRM_${spId}_${f.postfix}`,
          userTypeId: f.userTypeId,
          editInList: 'Y',
          editFormLabel: { ru: f.label },
        })),
      },
    }
  }

  /** Список смарт-процессов портала: старые названия, у «Шаблона» клиент и роботы включены. */
  const LEGACY_TYPES = {
    result: {
      types: [
        { id: TEMPLATE.id, entityTypeId: TEMPLATE.entityTypeId, title: 'Шаблон опроса', isClientEnabled: 'Y', isAutomationEnabled: 'Y' },
        { id: SURVEY.id, entityTypeId: SURVEY.entityTypeId, title: 'Опрос', isClientEnabled: 'Y', isAutomationEnabled: 'Y' },
      ],
    },
  }

  /** Портал, обустроенный до ревизии 4. */
  function legacyPortal(overrides: Answers = {}) {
    return portal({
      'crm.type.list': LEGACY_TYPES,
      'userfieldconfig.list': legacyFields,
      'crm.deal.userfield.list': { result: [{ ID: 11, FIELD_NAME: 'UF_CRM_SHEF_SURVEY_SCORE', EDIT_FORM_LABEL: 'Оценка клиента' }] },
      'crm.contact.userfield.list': { result: [{ ID: 12, FIELD_NAME: 'UF_CRM_SHEF_SURVEY_SCORE', EDIT_FORM_LABEL: '[sh] Оценка клиента' }] },
      ...overrides,
    })
  }

  /** Обустроить прежний портал, чьи идентификаторы сохранены, — обычный путь донастройки. */
  function migrate(p: ReturnType<typeof portal>) {
    return provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY }, { previousRevision: 3, resultHandlerUrl: 'https://polls.bx-shef.by/uf/survey-result' })
  }

  /**
   * Правки типов, кроме связи со сделкой и включения стадий: они ходят тем же методом,
   * но это другие шаги (стадии — ревизия 5, их тесты ниже).
   */
  const typeUpdates = (p: ReturnType<typeof portal>) => p.of('crm.type.update')
    .map(c => c.params.fields as Record<string, unknown>)
    .filter(fields => !('relations' in fields) && !('isStagesEnabled' in fields))
  const lockedIds = (p: ReturnType<typeof portal>) => p.of('userfieldconfig.update').map(c => c.params.id)

  it('известные по идентификатору переименовываются, «Шаблон» теряет клиента и роботов', async () => {
    const p = legacyPortal()

    await migrate(p)

    expect(typeUpdates(p)).toEqual([
      { title: '[sh] Шаблон опроса' },
      { isClientEnabled: 'N', isAutomationEnabled: 'N' },
      { title: '[sh] Результат опросов' },
    ])
    // Список типов нужен одному шагу переименования, и просится один раз.
    expect(p.of('crm.type.list')).toHaveLength(1)
  })

  it('ГЛАВНОЕ: наши поля закрываются от правки и получают метку — и поле виджета тоже', async () => {
    const p = legacyPortal()

    const result = await migrate(p)

    const locked = p.of('userfieldconfig.update').map(c => c.params.field as { editInList: string, editFormLabel: { ru: string } })
    expect(locked).toHaveLength(TEMPLATE_FIELDS.length + LEGACY_SURVEY_FIELDS.length)
    expect(locked.every(field => field.editInList === 'N')).toBe(true)
    expect(locked.map(field => field.editFormLabel.ru)).toEqual(expect.arrayContaining(['[sh] Ответы (JSON)', '[sh] Результат опроса']))
    // Три правки типов, четырнадцать полей, одна подпись на сделке — точным числом:
    // `expect.any(Number)` пропустил бы и лишние вызовы, и недостающие.
    expect(result.ownership).toEqual({ changes: 3 + TEMPLATE_FIELDS.length + LEGACY_SURVEY_FIELDS.length + 1, fieldsLocked: true, settled: true })
  })

  it('новое поле «Ссылка на анкету» создаётся сразу закрытым и в миграции не правится', async () => {
    const p = legacyPortal()

    await migrate(p)

    const added = p.of('userfieldconfig.add').map(c => c.params.field as Record<string, unknown>)
    expect(added).toEqual([expect.objectContaining({ fieldName: `UF_CRM_${SURVEY.id}_LINK`, editInList: 'N', editFormLabel: { ru: '[sh] Ссылка на анкету' } })])
  })

  it('поля сделки, не прочитанные шагом создания, миграция перечитывает сама', async () => {
    // Гвард из второго круга панели PR #87: эта ветка не выполнялась ни одним тестом. Список
    // полей сделки упал на шаге создания — подписи всё равно должны доехать.
    let dealLists = 0
    const p = legacyPortal({
      'crm.deal.userfield.list': () => {
        dealLists++
        if (dealLists === 1) throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        return { result: [{ ID: 11, FIELD_NAME: 'UF_CRM_SHEF_SURVEY_SCORE', EDIT_FORM_LABEL: 'Оценка клиента' }] }
      },
    })

    const result = await migrate(p)

    expect(result.crmFields).toBeNull()
    expect(p.of('crm.deal.userfield.update')).toHaveLength(1)
    expect(result.ownership?.settled).toBe(true)
  })

  it('поля сделки не прочитались и повторно — миграция не завершена', async () => {
    const p = legacyPortal({
      'crm.deal.userfield.list': () => {
        throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      },
    })

    const result = await migrate(p)

    expect(result.ownership?.settled).toBe(false)
  })

  it('подпись поля сделки получает метку, уже помеченное у контакта не трогается', async () => {
    const p = legacyPortal()

    await migrate(p)

    expect(p.of('crm.deal.userfield.update')).toEqual([{
      method: 'crm.deal.userfield.update',
      params: { id: 11, fields: { LIST_COLUMN_LABEL: '[sh] Оценка клиента', LIST_FILTER_LABEL: '[sh] Оценка клиента', EDIT_FORM_LABEL: '[sh] Оценка клиента' } },
    }])
    expect(p.of('crm.contact.userfield.update')).toHaveLength(0)
  })

  it('не повторяется на портале, уже перешедшем на ревизию 4', async () => {
    // Иначе мы спорили бы с администратором, переименовавшим смарт-процесс по-своему.
    const p = legacyPortal()

    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY }, { previousRevision: 4 })

    expect(result.ownership).toBeNull()
    expect(p.of('userfieldconfig.update')).toHaveLength(0)
    expect(typeUpdates(p)).not.toContainEqual({ title: '[sh] Результат опросов' })
  })

  it('ГЛАВНОЕ: найденный по прежнему названию НЕ переименовывается и не перенастраивается', async () => {
    // Гвард под главную находку `/review` и `/code-review` в PR #87. На свежей установке
    // идентификаторов нет, а у клиента может оказаться свой «Шаблон опроса» с роботами.
    // Переименовав его и выключив ему роботов и «Клиента», мы испортили бы чужие настройки.
    const p = legacyPortal()

    const result = await provisionSmartProcesses(p.call, {}, { previousRevision: 0 })

    expect(result.adoptedTemplate).toBe(true)
    expect(result.adoptedSurvey).toBe(true)
    expect(typeUpdates(p)).toEqual([])
  })

  it('в смешанном случае трогает только известный по идентификатору', async () => {
    // Гвард из мутационного прогона панели PR #87: смешанный случай не собирался ни разу.
    // «Опрос» известен по сохранённому идентификатору, «Шаблон» потерян и найден по названию.
    const p = legacyPortal()

    const result = await provisionSmartProcesses(p.call, { survey: SURVEY }, { previousRevision: 3 })

    expect(result.adoptedTemplate).toBe(true)
    expect(typeUpdates(p)).toEqual([{ title: '[sh] Результат опросов' }])
    // Список, прочитанный поиском, миграция берёт готовым — второй раз не просит.
    expect(p.of('crm.type.list')).toHaveLength(1)
  })

  it('усыновлённый прошлым прогоном не переименовывается и теперь', async () => {
    // Признак хранится с идентификаторами: сохранённый идентификатор ещё не значит «наш».
    const p = legacyPortal()

    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY, adopted: { template: true } }, { previousRevision: 3 })

    expect(result.adoptedTemplate).toBe(true)
    expect(typeUpdates(p)).toEqual([{ title: '[sh] Результат опросов' }])
  })

  it('известный, но пропавший из списка портала не трогается вслепую', async () => {
    // Гвард из второго круга панели PR #87: пропуск «нет в списке» можно было убрать, и не краснело
    // ничего. Идентификатор мог уйти в корзину — переименовывать по нему было бы вслепую.
    const p = legacyPortal({ 'crm.type.list': { result: { types: [LEGACY_TYPES.result.types[1]] } } })

    const result = await migrate(p)

    expect(typeUpdates(p)).toEqual([{ title: '[sh] Результат опросов' }])
    expect(result.ownership?.settled).toBe(true)
  })

  it('название, данное администратором, не трогается — переименовываем только наше прежнее', async () => {
    // Гвард под находку `/review` во втором круге PR #87: повтор незавершённой миграции иначе
    // спорил бы с администратором каждый час.
    const custom = { ...LEGACY_TYPES.result.types[0], title: 'Анкеты отдела' }
    const p = legacyPortal({ 'crm.type.list': { result: { types: [custom, LEGACY_TYPES.result.types[1]] } } })

    await migrate(p)

    expect(typeUpdates(p)).not.toContainEqual({ title: '[sh] Шаблон опроса' })
    expect(typeUpdates(p)).toContainEqual({ title: '[sh] Результат опросов' })
  })

  it('отказ, который повтор не вылечит, миграцию не держит', async () => {
    // Гвард под находку `/review` во втором круге PR #87: стабильное «доступ запрещён» на подписи
    // контакта держало бы портал на ревизии 3 навсегда — полное переобустройство каждый час.
    const p = legacyPortal({
      'crm.deal.userfield.update': () => {
        throw new PortalError('ACCESS_DENIED', 'Доступ запрещён')
      },
    })

    const result = await migrate(p)

    expect(result.ownership).toMatchObject({ fieldsLocked: true, settled: true })
  })

  it('сбой связи без кода портала миграцию держит — его лечит повтор', async () => {
    const p = legacyPortal({
      'crm.deal.userfield.update': () => {
        throw new Error('ECONNRESET')
      },
    })

    const result = await migrate(p)

    expect(result.ownership?.settled).toBe(false)
  })

  it('флаг «Шаблона» непонятной формы — выключение шлётся всё равно', async () => {
    // Выключение идемпотентно, а промолчав, мы оставили бы роботов включёнными навсегда.
    const odd = { ...LEGACY_TYPES.result.types[0], isClientEnabled: 'N', isAutomationEnabled: 1 }
    const p = legacyPortal({ 'crm.type.list': { result: { types: [odd, LEGACY_TYPES.result.types[1]] } } })

    await migrate(p)

    expect(typeUpdates(p)).toContainEqual({ isClientEnabled: 'N', isAutomationEnabled: 'N' })
  })

  it('созданный сейчас не переименовывается, известный рядом — да', async () => {
    const p = legacyPortal({ 'crm.type.list': { result: { types: [LEGACY_TYPES.result.types[0]] } } })

    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE }, { previousRevision: 3 })

    expect(result.createdSurvey).toBe(true)
    expect(typeUpdates(p)).toEqual([
      { title: '[sh] Шаблон опроса' },
      { isClientEnabled: 'N', isAutomationEnabled: 'N' },
    ])
  })

  it('незакрывшиеся поля видны исходом, и установка не падает', async () => {
    const p = legacyPortal({
      'userfieldconfig.update': () => {
        throw new PortalError('ACCESS_DENIED', 'Доступ запрещён')
      },
    })

    const result = await migrate(p)

    expect(result.ownership?.fieldsLocked).toBe(false)
  })

  it('одно упавшее поле не обрывает остальные', async () => {
    // Гвард под находку `/review` и `/code-review` в PR #87: цикл обрывался на первом отказе,
    // и поля за ним — `STATE`, `SCHEMA` — оставались открытыми.
    let first = true
    const p = legacyPortal({
      'userfieldconfig.update': (params: Record<string, unknown>) => {
        if (first) {
          first = false
          throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        }
        return { result: { field: { id: params.id, ...(params.field as object) } } }
      },
    })

    const result = await migrate(p)

    expect(lockedIds(p)).toHaveLength(TEMPLATE_FIELDS.length + LEGACY_SURVEY_FIELDS.length)
    // Правок сделано на одну меньше: упавший вызов правкой не считается.
    expect(result.ownership).toEqual({ changes: 3 + TEMPLATE_FIELDS.length + LEGACY_SURVEY_FIELDS.length - 1 + 1, fieldsLocked: false, settled: true })
  })

  it('двухсотый ответ с открытым полем закрытием не считается', async () => {
    // Флаг методом не документирован: портал, принявший запрос и оставивший поле открытым,
    // не должен отчитываться успехом — иначе ревизия отметится с открытым полем навсегда.
    const p = legacyPortal({
      'userfieldconfig.update': (params: Record<string, unknown>) => ({ result: { field: { id: params.id, editInList: 'Y', editFormLabel: (params.field as { editFormLabel: unknown }).editFormLabel } } }),
    })

    const result = await migrate(p)

    expect(result.ownership?.fieldsLocked).toBe(false)
  })

  it('поле без идентификатора настроек — не закрыто, остальные закрываются', async () => {
    const p = legacyPortal({
      'userfieldconfig.list': (params: Record<string, unknown>) => {
        const listed = legacyFields(params)
        if ((params.filter as { entityId: string }).entityId === `CRM_${TEMPLATE.id}`) delete (listed.result.fields[0] as { id?: number }).id
        return listed
      },
    })

    const result = await migrate(p)

    expect(result.ownership?.fieldsLocked).toBe(false)
    expect(lockedIds(p)).toHaveLength(TEMPLATE_FIELDS.length - 1 + LEGACY_SURVEY_FIELDS.length)
  })

  it('тарифный отказ переименования закрытию полей не мешает и миграцию не держит', async () => {
    // Тариф может запрещать правку смарт-процессов — поля при этом закрыть всё равно нужно,
    // а повтор такой отказ не вылечит.
    const p = legacyPortal({
      'crm.type.update': (params: Record<string, unknown>) => {
        if ('title' in (params.fields as object)) throw new PortalError('UPDATE_DYNAMIC_TYPE_RESTRICTED', 'Тариф')
        return { result: { type: { relations: WITH_DEAL } } }
      },
    })

    const result = await migrate(p)

    expect(result.ownership).toMatchObject({ fieldsLocked: true, settled: true })
    // Отказ одного вызова не обрывает соседние: выключение роботов у «Шаблона» ушло.
    expect(typeUpdates(p)).toContainEqual({ isClientEnabled: 'N', isAutomationEnabled: 'N' })
  })

  it('случайный отказ переименования оставляет миграцию незавершённой', async () => {
    // Гвард под находку `/review` и `/code-review` в PR #87: любой отказ отпускал ревизию,
    // и одно «слишком много запросов» навсегда отменяло переименование.
    let first = true
    const p = legacyPortal({
      'crm.type.update': (params: Record<string, unknown>) => {
        if (first && 'title' in (params.fields as object)) {
          first = false
          throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        }
        return { result: { type: { relations: WITH_DEAL } } }
      },
    })

    const result = await migrate(p)

    expect(result.ownership).toMatchObject({ fieldsLocked: true, settled: false })
    expect(typeUpdates(p)).toHaveLength(3)
  })

  it('созданные этим запуском не переименовываются: они уже с нынешним названием', async () => {
    const p = portal()

    await provisionSmartProcesses(p.call)

    expect(typeUpdates(p)).not.toContainEqual({ title: '[sh] Результат опросов' })
    expect(p.of('crm.type.add').map(c => (c.params.fields as { title: string }).title))
      .toEqual(['[sh] Шаблон опроса', '[sh] Результат опросов'])
  })

  it('ГЛАВНОЕ: на свежей установке миграция не делает ни одного вызова', async () => {
    // Гвард под находку программиста и `/code-review` в PR #87: миграция листала поля обоих
    // смарт-процессов, сделки и контакта заново — на критическом пути установки, под общим
    // пределом времени. Всё нужное уже прочитано шагами до неё.
    //
    // Сравниваем с ревизией 4, а не с текущей: воронку свежей установке настраивает ревизия 5,
    // и это законная цена (её держит «холодная установка» в `provision-outcome.test.ts`), а здесь
    // держится другое — что миграция 4 не добавляет ни одного вызова.
    const fresh = portal()
    const migrated = portal()

    await provisionSmartProcesses(fresh.call, {}, { previousRevision: OWNERSHIP_REVISION })
    await provisionSmartProcesses(migrated.call, {}, { previousRevision: 0 })

    expect(migrated.calls.map(c => c.method)).toEqual(fresh.calls.map(c => c.method))
  })

  it('«Шаблон» создаётся без клиента и роботов, «Результат опросов» — с ними', async () => {
    // Гвард из мутационного прогона панели PR #87: поменять `kind` местами в двух вызовах
    // было можно, и не краснело ничего — состав флагов проверялся только у построителя.
    const p = portal()

    await provisionSmartProcesses(p.call)

    const created = p.of('crm.type.add').map(c => c.params.fields as Record<string, unknown>)
    expect(created.map(fields => [fields.title, fields.isClientEnabled, fields.isAutomationEnabled])).toEqual([
      ['[sh] Шаблон опроса', false, false],
      ['[sh] Результат опросов', true, true],
    ])
  })
})
