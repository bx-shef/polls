import { describe, expect, it, vi } from 'vitest'
import { ensureDealRelation, isPortalAdmin, provisionSmartProcesses, readStoredRefs, SP_REFS_OPTION, storeRefs, withDeadline } from '../../server/b24/provision'
import { DEAL_ENTITY_TYPE_ID, planDealRelation, readTypeRelations, SURVEY_FIELDS, TEMPLATE_FIELDS, type TypeRelations } from '../../server/domain/portals/smart-processes'

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
    // ⚠ Умолчание — смарт-процесс, СОЗДАННЫЙ С `isClientEnabled`: Контакт и Компания
    // стоят родителями и помечены `isPredefined`, а Сделки среди них НЕТ. Это не выдумка
    // подделки, а дословная форма ответа из документации `crm.type.get`, и именно это
    // состояние месяц стояло на живом портале.
    if (method === 'crm.type.get') return { result: { type: { relations: CLIENT_ONLY } } }
    // Настоящий портал возвращает обновлённый тип целиком — проверено по ответу метода
    // в документации. Подделка применяет присланное, иначе она подтверждала бы что угодно.
    if (method === 'crm.type.update') {
      return { result: { type: { relations: (params.fields as { relations?: unknown }).relations } } }
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

    const sent = (p.of('crm.type.update')[0]!.params.fields as { relations: TypeRelations }).relations
    expect(sent.parent.map(r => r.entityTypeId).sort()).toEqual([2, 3, 4])
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

  it('отказ портала не роняет установку молча', async () => {
    // Тариф клиента может запрещать правку смарт-процессов (`UPDATE_DYNAMIC_TYPE_RESTRICTED`).
    // Приложение при этом остаётся рабочим в остальном, но исход обязан быть видимым —
    // за это отвечает `dealLinked`, а `register.ts` пишет по нему `logger.error`.
    const p = portal({
      'crm.type.update': () => {
        throw new Error('UPDATE_DYNAMIC_TYPE_RESTRICTED')
      },
    })

    await expect(provisionSmartProcesses(p.call)).rejects.toThrow()
  })
})

describe('планирование связи, без портала', () => {
  it('не планирует ничего, когда сделка уже в родителях', () => {
    // Идемпотентность: повторная установка не должна писать настройки заново.
    expect(planDealRelation(readTypeRelations({ result: { type: { relations: WITH_DEAL } } }))).toBeNull()
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

    expect(deal!.isChildrenListEnabled).toBe('Y')
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

    expect(await readStoredRefs(p.call)).toEqual({ template: TEMPLATE, survey: SURVEY })
  })

  it.each<[unknown, string]>([
    [{ result: null }, 'ничего не сохранено'],
    [{ result: 'не json' }, 'испорченное значение'],
    [{ result: JSON.stringify({ template: { entityTypeId: 0, id: 0 } }) }, 'нули вместо идентификаторов'],
  ])('не падает на негодном значении (%#: %s)', async (answer) => {
    const p = portal({ 'app.option.get': answer })

    // Не прочитали — найдём смарт-процессы по заголовку и перезапишем. Установка не должна
    // спотыкаться о собственную настройку.
    expect(await readStoredRefs(p.call)).toEqual({ template: undefined, survey: undefined })
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
