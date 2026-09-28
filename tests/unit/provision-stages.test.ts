import { afterEach, describe, expect, it, vi } from 'vitest'
import { carryStates, dropStateField, provisionSmartProcesses } from '../../server/b24/provision'
import { provisionWithCall } from '../../server/b24/register'
import { findProcesses } from '../../server/b24/write-templates'
import { PortalError } from '../../server/domain/portals/portal-error'
import { logger } from '../../server/utils/logger'

/**
 * Ревизия 5: штатные стадии вместо своего поля «Состояние» (issue #84, п. 21).
 *
 * Держим здесь то, что стоит данных клиента: переносом состояние не теряется, поле удаляется только
 * после чистого переноса, чужой смарт-процесс не перекраивается, а признак «на стадиях» сохраняется
 * раньше переноса — иначе опрос, пройденный посреди миграции, остался бы «Отправленным» навсегда.
 *
 * Идентификаторы и формы ответов — с тестового портала 28.09 (разбор в `docs/PROCESS.md`).
 */

const TEMPLATE = { entityTypeId: 1038, id: 8 }
const SURVEY = { entityTypeId: 1040, id: 10 }
const FUNNEL = { 1038: 14, 1040: 16 } as Record<number, number>

type Answer = unknown | ((params: Record<string, unknown>) => unknown)

/** Стадии свежей воронки — ровно те, что портал ставит сам. */
function freshStages(entityId: string) {
  const [, e, , c] = entityId.split('_')
  const names = [['NEW', 'Начало'], ['PREPARATION', 'Подготовка'], ['CLIENT', 'Согласование'], ['SUCCESS', 'Успех'], ['FAIL', 'Провал']]
  return names.map(([code, name], index) => ({ ID: String(300 + index), STATUS_ID: `DT${e}_${c}:${code}`, NAME: name }))
}

/** Подделка портала: уже обустроенного ревизией 4, со стадиями по умолчанию. */
function portal(answers: Record<string, Answer> = {}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    const answer = answers[method]
    if (typeof answer === 'function') return (answer as (p: Record<string, unknown>) => unknown)(params)
    if (answer !== undefined) return answer
    if (method === 'user.admin') return { result: true }
    if (method === 'app.option.get') return { result: JSON.stringify({ template: TEMPLATE, survey: SURVEY, revision: 4 }) }
    if (method === 'crm.type.list') return { result: { types: [] } }
    if (method === 'crm.category.list') return { result: { categories: [{ id: FUNNEL[params.entityTypeId as number], isDefault: 'Y' }] } }
    if (method === 'crm.status.list') return { result: freshStages(String((params.filter as { ENTITY_ID: string }).ENTITY_ID)) }
    if (method === 'crm.item.list') return { result: { items: [] } }
    if (method === 'userfieldconfig.list') return { result: { fields: [] } }
    if (method === 'crm.type.get') return { result: { type: { relations: { parent: [{ entityTypeId: 2, isChildrenListEnabled: 'Y' }], child: [] } } } }
    if (method === 'app.info') return { result: { ID: 219, INSTALLED: true } }
    if (method === 'userfieldtype.list') return { result: [] }
    return { result: true }
  })
  const of = (method: string) => calls.filter(one => one.method === method)
  return { call, calls, of }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('настройка стадий', () => {
  it('включает стадии у известного смарт-процесса, находит воронку и называет стадии по-нашему', async () => {
    const p = portal()

    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY }, { previousRevision: 4 })

    expect(p.of('crm.type.update').map(one => one.params)).toContainEqual({ id: 10, fields: { isStagesEnabled: true } })
    expect(result.survey).toEqual({ ...SURVEY, categoryId: 16 })
    expect(result.template).toEqual({ ...TEMPLATE, categoryId: 14 })
    expect(p.of('crm.status.update').map(one => (one.params.fields as { NAME: string }).NAME)).toEqual([
      'Черновик', 'Опубликован', 'Снят с публикации', 'Отправлена', 'Пройдена', 'Отозвана',
    ])
    expect(p.of('crm.status.delete')).toHaveLength(4)
    expect(result.stages.settled).toBe(true)
  })

  it('ГЛАВНОЕ: усыновлённый смарт-процесс не трогает — ни стадий, ни воронки', async () => {
    // Найденный по названию может оказаться чужим: включив ему стадии и переименовав их,
    // мы переделали бы клиенту его процесс. Он остаётся на старом поле.
    const p = portal()

    const result = await provisionSmartProcesses(
      p.call,
      { template: TEMPLATE, survey: SURVEY, adopted: { survey: true } },
      { previousRevision: 4 },
    )

    expect(p.of('crm.type.update').map(one => one.params.id)).not.toContain(10)
    expect(p.of('crm.category.list').map(one => one.params.entityTypeId)).toEqual([1038])
    expect(result.survey).toEqual(SURVEY)
  })

  it('ГЛАВНОЕ: наш смарт-процесс после переустановки — стадии уже включены — воронку узнаёт чтением', async () => {
    // ⚠ Найденный по названию чаще всего НАШ, переживший переустановку: уже на стадиях, с удалённым
    // полем «Состояние». Не узнав воронку, приложение завело бы поле заново, пустым, и все
    // опубликованные анкеты перестали бы читаться. Сами — ничего не включаем и не называем.
    // Нашли `/review`, `/code-review` и программист в панели PR #93.
    const p = portal({
      'app.option.get': { result: '' },
      'crm.type.list': { result: { types: [
        { id: 8, entityTypeId: 1038, title: '[sh] Шаблон опроса', isStagesEnabled: 'Y' },
        { id: 10, entityTypeId: 1040, title: '[sh] Результат опросов', isStagesEnabled: true },
      ] } },
    })

    const result = await provisionSmartProcesses(p.call, {}, { previousRevision: 0 })

    expect(result.template).toEqual({ ...TEMPLATE, categoryId: 14 })
    expect(result.survey).toEqual({ ...SURVEY, categoryId: 16 })
    expect(p.of('crm.type.update').filter(one => 'isStagesEnabled' in (one.params.fields as object))).toEqual([])
    expect(p.of('crm.status.update')).toEqual([])
    expect(p.of('crm.status.delete')).toEqual([])
    const added = p.of('userfieldconfig.add').map(one => (one.params.field as { fieldName: string }).fieldName)
    expect(added.some(name => name.endsWith('_STATE'))).toBe(false)
  })

  it('ГЛАВНОЕ: усыновлённый прошлым прогоном — стадии узнаются у самого типа, и тоже только чтением', async () => {
    // Оба идентификатора сохранены — список типов не листается, и спросить можно только `crm.type.get`.
    // Эту ветку не держал ни один тест: нашёл тестировщик во втором круге панели PR #93.
    const p = portal({
      'crm.type.get': (params: Record<string, unknown>) => ({ result: { type: {
        isStagesEnabled: params.id === 10 ? 'Y' : 'N',
        relations: { parent: [{ entityTypeId: 2, isChildrenListEnabled: 'Y' }], child: [] },
      } } }),
    })

    const result = await provisionSmartProcesses(
      p.call,
      { template: TEMPLATE, survey: SURVEY, adopted: { survey: true } },
      { previousRevision: 4 },
    )

    expect(result.survey).toEqual({ ...SURVEY, categoryId: 16 })
    expect(p.of('crm.type.get').map(one => one.params.id)).toContain(10)
    expect(p.of('crm.type.update').filter(one => one.params.id === 10 && 'isStagesEnabled' in (one.params.fields as object))).toEqual([])
    expect(p.of('crm.status.list').map(one => (one.params.filter as { ENTITY_ID: string }).ENTITY_ID)).not.toContain('DYNAMIC_1040_STAGE_16')
  })

  it('ГЛАВНОЕ: усыновлённый со стадиями, воронка не прочиталась — обустройство падает, а не заводит поле заново', async () => {
    // ⚠ Пойдя дальше старым полем, обустройство завело бы «Состояние» заново, пустым, и до следующей
    // донастройки анкеты читались бы из пустоты. Нашёл `/code-review` во втором круге панели PR #93.
    const p = portal({
      'app.option.get': { result: '' },
      'crm.type.list': { result: { types: [
        { id: 8, entityTypeId: 1038, title: '[sh] Шаблон опроса', isStagesEnabled: 'Y' },
        { id: 10, entityTypeId: 1040, title: '[sh] Результат опросов', isStagesEnabled: 'Y' },
      ] } },
      'crm.category.list': () => {
        throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      },
    })

    await expect(provisionSmartProcesses(p.call, {}, { previousRevision: 0 })).rejects.toThrow()
    expect(p.of('userfieldconfig.add')).toEqual([])
  })

  it('усыновлённый со стадиями, а воронки в ответе нет — тоже падает, а не идёт старым полем', async () => {
    const p = portal({
      'app.option.get': { result: '' },
      'crm.type.list': { result: { types: [
        { id: 8, entityTypeId: 1038, title: '[sh] Шаблон опроса', isStagesEnabled: 'Y' },
        { id: 10, entityTypeId: 1040, title: '[sh] Результат опросов', isStagesEnabled: 'Y' },
      ] } },
      'crm.category.list': { result: { categories: [] } },
    })

    await expect(provisionSmartProcesses(p.call, {}, { previousRevision: 0 })).rejects.toThrow()
    expect(p.of('userfieldconfig.add')).toEqual([])
  })

  it('тариф не дал включить стадии — смарт-процесс остаётся на старом поле, и это ошибка в журнале', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const p = portal({
      'crm.type.update': (params: Record<string, unknown>) => {
        if ('isStagesEnabled' in (params.fields as object)) throw new PortalError('UPDATE_DYNAMIC_TYPE_RESTRICTED', 'Тариф не позволяет')
        return { result: true }
      },
    })

    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY }, { previousRevision: 4 })

    expect(result.survey.categoryId).toBeUndefined()
    // Повтор тариф не вылечит: возвращаться к порталу каждый час незачем.
    expect(result.stages.settled).toBe(true)
    expect(error.mock.calls.some(([, message]) => String(message).includes('повтор не поможет'))).toBe(true)
  })

  it('воронки нет в ответе — смарт-процесс остаётся на старом поле, повторять незачем', async () => {
    // Воронка по умолчанию есть всегда (замерено 28.09); ответ без неё — не той формы, и повтор
    // его не исправит. Режим стадий без воронки не включить: писали бы в стадии, которых нет.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const p = portal({ 'crm.category.list': { result: { categories: [] } } })

    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY }, { previousRevision: 4 })

    expect(result.survey.categoryId).toBeUndefined()
    expect(result.stages.settled).toBe(true)
    expect(warn.mock.calls.some(([, message]) => String(message).includes('воронка по умолчанию не найдена'))).toBe(true)
  })

  it('предел запросов — повторимый отказ: ревизию не отмечаем, донастройка вернётся', async () => {
    const p = portal({
      'crm.category.list': () => {
        throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      },
    })

    const result = await provisionSmartProcesses(p.call, { template: TEMPLATE, survey: SURVEY }, { previousRevision: 4 })

    expect(result.stages.settled).toBe(false)
    expect(result.survey.categoryId).toBeUndefined()
  })

  it('смарт-процесс, пересозданный на портале ревизии 5, сразу получает воронку', async () => {
    // Разовый шаг миграции позади, но новый смарт-процесс создан со стадиями: без воронки в ссылке
    // он жил бы полем «Состояние», заведённым заново, а в канбане всё стояло бы в первой стадии.
    const p = portal({
      'crm.type.add': { result: { type: SURVEY } },
    })

    const result = await provisionSmartProcesses(p.call, { template: { ...TEMPLATE, categoryId: 14 } }, { previousRevision: 5 })

    expect(result.survey).toEqual({ ...SURVEY, categoryId: 16 })
    expect(p.of('crm.category.list').map(one => one.params.entityTypeId)).toEqual([1040])
    const added = p.of('userfieldconfig.add').map(one => (one.params.field as { fieldName: string }).fieldName)
    expect(added.some(name => name.endsWith('_STATE'))).toBe(false)
  })

  it('со стадиями поле «Состояние» не заводится', async () => {
    // Иначе обустройство создавало бы его заново после того, как перенос его удалил.
    const p = portal({
      'app.option.get': { result: '' },
      'crm.type.add': (params: Record<string, unknown>) => ({
        result: { type: String((params.fields as { title: string }).title).includes('Шаблон') ? TEMPLATE : SURVEY },
      }),
    })

    await provisionSmartProcesses(p.call, {}, { previousRevision: 0 })

    const added = p.of('userfieldconfig.add').map(one => (one.params.field as { fieldName: string }).fieldName)
    expect(added.some(name => name.endsWith('_STATE'))).toBe(false)
    expect(added.length).toBeGreaterThan(0)
    // И в раскладку карточки его имя не попадает: там осталось бы имя без поля.
    const card = p.of('crm.item.details.configuration.set')
    expect(card).toHaveLength(1)
    expect(JSON.stringify(card)).not.toContain('_STATE')
  })
})

describe('перенос старого поля «Состояние»', () => {
  const STAGED_TEMPLATE = { ...TEMPLATE, categoryId: 14 }
  const STAGED_SURVEY = { ...SURVEY, categoryId: 16 }
  /** Наши поля «Состояние» — такими их нашло листание полей обустройства (`stateFields`). */
  const SURVEY_FIELD = { id: 71, name: 'UF_CRM_10_STATE', userTypeId: 'string', editInList: 'N' as const, label: '' }
  const TEMPLATE_FIELD = { id: 72, name: 'UF_CRM_8_STATE', userTypeId: 'string', editInList: 'N' as const, label: '' }
  const clock = () => ({ deadline: Number.POSITIVE_INFINITY, now: () => Date.parse('2026-09-28T10:00:00Z') })
  const fresh = () => ({ changes: 0, settled: true })

  /**
   * Подделка списка элементов, которая ОТБИРАЕТ, как портал: по стадии (если спросили), значению
   * поля и `>id`, отдаёт поля в camelCase и помнит переводы — следующий отбор их уже не находит.
   */
  function stored(items: Record<number, Record<string, unknown>[]>, pageSize = 50) {
    const camel = (name: string) => name.toLowerCase().split('_').map((part, i) => i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)).join('')
    const list = (params: Record<string, unknown>) => {
      const filter = params.filter as Record<string, unknown>
      const stateKey = Object.keys(filter).find(key => key.replace('@', '').startsWith('ufCrm'))!
      const wanted = ([] as unknown[]).concat(filter[stateKey])
      const matches = (items[params.entityTypeId as number] ?? []).filter((item) => {
        const state = Object.entries(item).find(([key]) => camel(key) === stateKey.replace('@', ''))?.[1]
        return (filter.stageId === undefined || item.stageId === filter.stageId) && Number(item.id) > Number(filter['>id']) && wanted.includes(state)
      })
      const page = matches.slice(0, pageSize).map(item => Object.fromEntries(Object.entries(item).map(([key, value]) => [key.startsWith('UF_') ? camel(key) : key, value])))
      return { result: { items: page }, ...(matches.length > pageSize ? { next: pageSize } : {}) }
    }
    const update = (params: Record<string, unknown>) => {
      const item = (items[params.entityTypeId as number] ?? []).find(one => one.id === params.id)!
      Object.assign(item, params.fields as object)
      return { result: { item: { id: params.id } } }
    }
    return { 'crm.item.list': list, 'crm.item.update': update }
  }

  it('ГЛАВНОЕ: переводит по старому полю и только потом удаляет поле', async () => {
    const p = portal(stored({
      1040: [
        { id: 1, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' },
        { id: 2, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'sent' },
        { id: 3, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'revoked' },
      ],
      1038: [{ id: 4, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: null, updatedTime: '2026-09-21T10:00:00+03:00' }],
    }))
    const outcome = fresh()

    for (const [ref, kind, field] of [[STAGED_TEMPLATE, 'template', TEMPLATE_FIELD], [STAGED_SURVEY, 'survey', SURVEY_FIELD]] as const) {
      if (await carryStates(p.call, ref, kind, field, outcome, clock())) await dropStateField(p.call, ref, field, outcome, clock())
    }

    expect(p.of('crm.item.update').map(one => [one.params.id, one.params.fields])).toEqual([
      [4, { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_PUBLISHED_AT: '2026-09-21' }],
      [1, { stageId: 'DT1040_16:SUCCESS' }],
      [3, { stageId: 'DT1040_16:FAIL' }],
    ])
    expect(p.of('userfieldconfig.delete').map(one => one.params.id)).toEqual([72, 71])
    // Удаление — после переноса своего смарт-процесса, а не до: иначе переносить было бы уже нечем.
    const at = (method: string, id: number) => p.calls.findIndex(one => one.method === method && one.params.id === id)
    expect(at('userfieldconfig.delete', 72)).toBeGreaterThan(at('crm.item.update', 4))
    expect(at('userfieldconfig.delete', 71)).toBeGreaterThan(at('crm.item.update', 3))
    expect(outcome.settled).toBe(true)
  })

  it('ГЛАВНОЕ: отбирает портал, и ответов клиентов в отборе нет', async () => {
    // ⚠ Первая редакция листала всё с `select: ['*']`: на сотнях опросов перенос не укладывался
    // в бюджет обустройства, а в память сервера ехали ответы клиентов. Нашли `/review`,
    // `/code-review` и безопасность в панели PR #93.
    const p = portal(stored({ 1040: [] }))

    await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, fresh(), clock())

    const [list] = p.of('crm.item.list')
    expect(list!.params).toEqual({
      entityTypeId: 1040,
      select: ['id', 'stageId', 'updatedTime', 'ufCrm10State'],
      filter: { 'stageId': 'DT1040_16:NEW', '>id': 0, '@ufCrm10State': ['completed', 'revoked'] },
      order: { id: 'ASC' },
    })
  })

  it('ГЛАВНОЕ: шаблоны — в любой стадии: дата досылается всегда, стадия двигается только из первой', async () => {
    // ⚠ Опубликованная полем анкета без даты, которую администратор успел перетащить из «Черновика»
    // до переноса, иначе не получила бы даты — и после удаления поля навсегда читалась бы правимым
    // черновиком. Нашёл `/review` во втором круге панели PR #93.
    const items = { 1038: [
      { id: 4, stageId: 'DT1038_14:FAIL', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-21T10:00:00+03:00' },
      { id: 5, stageId: 'DT1038_14:SUCCESS', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '2026-09-20T03:00:00+03:00', updatedTime: '2026-09-25T10:00:00+03:00' },
    ] }
    const p = portal(stored(items))

    expect(await carryStates(p.call, STAGED_TEMPLATE, 'template', TEMPLATE_FIELD, fresh(), clock())).toBe(true)

    expect((p.of('crm.item.list')[0]!.params.filter as Record<string, unknown>)).not.toHaveProperty('stageId')
    // Снятая администратором осталась снятой, но получила дату; датированной делать нечего.
    expect(p.of('crm.item.update').map(one => [one.params.id, one.params.fields])).toEqual([
      [4, { UF_CRM_8_PUBLISHED_AT: '2026-09-21' }],
    ])
  })

  it('отказ, который повтор не вылечит, — ошибкой в журнал: поле остаётся, но ревизию он не держит', async () => {
    // ⚠ Держи он ревизию, один такой элемент гонял бы донастройку портала каждый час бесконечно.
    // Тот же размен, что у `refuse` ревизии 4. Нашёл `/code-review` во втором круге панели PR #93.
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const items = { 1040: [
      { id: 1, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' },
      { id: 2, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'revoked' },
    ] }
    const fake = stored(items)
    const p = portal({
      ...fake,
      'crm.item.update': (params: Record<string, unknown>) => {
        if (params.id === 1) throw new PortalError('ACCESS_DENIED', 'Access denied')
        return fake['crm.item.update'](params)
      },
    })
    const outcome = fresh()

    expect(await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, outcome, clock())).toBe(false)
    expect(outcome.settled).toBe(true)
    expect(items[1040][1]!.stageId).toBe('DT1040_16:FAIL')
    expect(error.mock.calls.some(([, message]) => String(message).includes('повтор не поможет'))).toBe(true)
  })

  it('ГЛАВНОЕ: повторимый отказ на элементе — поле остаётся, прочие переведены, ревизия ждёт', async () => {
    const items = { 1040: [
      { id: 1, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' },
      { id: 2, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'revoked' },
    ] }
    const fake = stored(items)
    const p = portal({
      ...fake,
      'crm.item.update': (params: Record<string, unknown>) => {
        if (params.id === 1) throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        return fake['crm.item.update'](params)
      },
    })
    const outcome = fresh()

    expect(await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, outcome, clock())).toBe(false)
    expect(outcome.settled).toBe(false)
    expect(items[1040][1]!.stageId).toBe('DT1040_16:FAIL')
  })

  it('листает по номеру элемента, пока портал отдаёт следующую страницу', async () => {
    // Переведённые выпадают из отбора, и смещение перескакивало бы через непрочитанные.
    const items = { 1040: [5, 6, 7].map(id => ({ id, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' })) }
    const p = portal(stored(items, 2))

    expect(await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, fresh(), clock())).toBe(true)

    expect(p.of('crm.item.update').map(one => one.params.id)).toEqual([5, 6, 7])
    expect(p.of('crm.item.list').map(one => (one.params.filter as Record<string, unknown>)['>id'])).toEqual([0, 6])
  })

  it('ГЛАВНОЕ: портал говорит «есть ещё», а листание не продвигается — не «всё перенесено»', async () => {
    // ⚠ Вернув здесь «чисто», мы удалили бы поле с непрочитанными страницами. Нашли `/review`
    // и `/code-review` во втором круге панели PR #93.
    const p = portal({ 'crm.item.list': { result: { items: [] }, next: 50 } })
    const outcome = fresh()

    expect(await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, outcome, clock())).toBe(false)
    expect(outcome.settled).toBe(false)
    expect(p.of('crm.item.list')).toHaveLength(1)
  })

  it('ГЛАВНОЕ: упёрся в предел страниц — не «перенесено всё», поле остаётся', async () => {
    let next = 0
    const p = portal({
      'crm.item.list': () => ({ result: { items: [{ id: ++next, stageId: 'DT1040_16:NEW', ufCrm10State: 'completed' }] }, next: 50 }),
    })
    const outcome = fresh()

    expect(await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, outcome, clock())).toBe(false)
    expect(outcome.settled).toBe(false)
  })

  it('ГЛАВНОЕ: свой предел времени — останавливается и ждёт следующей донастройки', async () => {
    // ⚠ Упрись перенос в общий предел обустройства, прогон кончился бы `failed`, портал ушёл бы
    // в `degraded`, а вкладки и отметку ревизии было бы нечем записать. Нашёл `/review`.
    const items = { 1040: [1, 2, 3].map(id => ({ id, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' })) }
    const p = portal(stored(items))
    let now = 0
    const outcome = fresh()

    const clean = await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, outcome, { deadline: 3, now: () => now++ })

    expect(clean).toBe(false)
    expect(outcome.settled).toBe(false)
    expect(p.of('crm.item.update').length).toBeLessThan(3)
  })

  it('ответ не той формы — не «переносить нечего»', async () => {
    // Пустой список значил бы «всё перенесено», и поле удалилось бы вместе с состоянием
    // элементов, которых мы просто не прочитали.
    const p = portal({ 'crm.item.list': { result: {} } })
    const outcome = fresh()

    expect(await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, outcome, clock())).toBe(false)
    expect(outcome.settled).toBe(false)
  })

  it('ГЛАВНОЕ: в строке отбора не видно того, по чему отбирали, — перенос не закончен', async () => {
    // ⚠ Другое написание поля у портала выглядело бы чистым проходом без единого перевода, и поле
    // удалилось бы вместе с состоянием всех элементов. Нашёл `/code-review` во втором круге панели.
    const p = portal({ 'crm.item.list': { result: { items: [{ ID: 7, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' }] } } })
    const outcome = fresh()

    expect(await carryStates(p.call, STAGED_SURVEY, 'survey', SURVEY_FIELD, outcome, clock())).toBe(false)
    expect(outcome.settled).toBe(false)
    expect(p.of('crm.item.update')).toEqual([])
  })

  it('поля «Состояние» уже нет — ни отбора, ни удаления', async () => {
    const p = portal()
    const outcome = fresh()

    expect(await carryStates(p.call, STAGED_SURVEY, 'survey', null, outcome, clock())).toBe(true)
    await dropStateField(p.call, STAGED_SURVEY, null, outcome, clock())

    expect(p.calls).toEqual([])
  })

  it('поле без идентификатора настроек не удаляется — и это видно в журнале', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const p = portal()

    await dropStateField(p.call, STAGED_SURVEY, { ...SURVEY_FIELD, id: 0 }, fresh(), clock())

    expect(p.of('userfieldconfig.delete')).toEqual([])
    expect(warn.mock.calls.some(([, message]) => String(message).includes('не удалено'))).toBe(true)
  })

  it('время переноса вышло — поле удаляется следующей донастройкой, а не за пределом', async () => {
    const p = portal()
    const outcome = fresh()

    await dropStateField(p.call, STAGED_SURVEY, SURVEY_FIELD, outcome, { deadline: 0, now: () => 1 })

    expect(p.of('userfieldconfig.delete')).toEqual([])
    expect(outcome.settled).toBe(false)
  })

  it('повторимый отказ удаления держит ревизию', async () => {
    const p = portal({
      'userfieldconfig.delete': () => {
        throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      },
    })
    const outcome = fresh()

    await dropStateField(p.call, STAGED_SURVEY, SURVEY_FIELD, outcome, clock())

    expect(outcome.settled).toBe(false)
  })

  it('имя удалённого поля уходит и из сохранённой раскладки карточки, остальное — как было', async () => {
    // Раскладка хранит поля по имени (замерено 28.09): без этого в карточке каждого старого
    // портала осталось бы имя без поля. Нашёл `/review` в панели PR #93.
    const layout = [
      { name: 'survey_form', elements: [{ name: 'UF_CRM_10_TEMPLATE_CODE' }, { name: 'UF_CRM_10_STATE' }, { name: 'UF_CRM_10_LINK' }] },
      { name: 'client_own', elements: [{ name: 'UF_CRM_10_STATE' }] },
    ]
    const p = portal({ 'crm.item.details.configuration.get': { result: layout } })

    await dropStateField(p.call, STAGED_SURVEY, SURVEY_FIELD, fresh(), clock())

    const [set] = p.of('crm.item.details.configuration.set')
    expect(set!.params.data).toEqual([
      { name: 'survey_form', elements: [{ name: 'UF_CRM_10_TEMPLATE_CODE' }, { name: 'UF_CRM_10_LINK' }] },
      { name: 'client_own', elements: [] },
    ])
  })

  it('ГЛАВНОЕ: раскладку без нашего поля или непонятную — не переписывает вовсе', async () => {
    // ⚠ `set` перезаписывает раскладку целиком и на всех: записав пустое вместо непонятного, мы
    // стёрли бы клиенту его карточку. Нашёл тестировщик во втором круге панели PR #93.
    for (const answer of [
      { result: [{ name: 'survey_form', elements: [{ name: 'UF_CRM_10_LINK' }] }] },
      { result: [] },
      { result: null },
      { result: [{ name: 'survey_form', elements: 'не массив' }] },
    ]) {
      const p = portal({ 'crm.item.details.configuration.get': answer })

      await dropStateField(p.call, STAGED_SURVEY, SURVEY_FIELD, fresh(), clock())

      expect(p.of('crm.item.details.configuration.set')).toEqual([])
    }
  })

  it('опубликованные до проверки схемы — в журнал кодами, без схем, и выпуск по ним сохраняется', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const holed = JSON.stringify({ code: 'brand', title: 'Бренд', sections: [{ key: 's', title: 'Раздел', scored: true, bands: [{ from: 0, to: 3, text: 'Плохо' }], questions: [{ key: 'q', sourceKey: 'q', title: 'Секретная формулировка', type: 'scale', weight: 100, scored: true, scale: { min: 0, max: 10 } }] }] })
    // Правленная руками схема без названия и диапазонов: проверка на ней бросает, а обустройство — нет.
    const bare = JSON.stringify({ code: 'bare', sections: [{ key: 's', questions: [{ key: 'q', type: 'scale' }] }] })
    const items = { 1038: [
      { id: 4, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: 2, UF_CRM_8_SCHEMA: holed, UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-21T10:00:00+03:00' },
      { id: 5, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_SCHEMA: bare, UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-21T10:00:00+03:00' },
    ] }
    const p = portal(stored(items))

    expect(await carryStates(p.call, STAGED_TEMPLATE, 'template', TEMPLATE_FIELD, fresh(), clock())).toBe(true)

    const line = warn.mock.calls.find(([, message]) => String(message).includes('до проверки схемы'))
    expect(line?.[0]).toMatchObject({ unchecked: ['brand v2', '? v?'] })
    expect(JSON.stringify(line)).not.toContain('Секретная формулировка')
    expect(items[1038][0]!.stageId).toBe('DT1038_14:SUCCESS')
  })
})

describe('порядок миграции целиком', () => {
  const FIELDS = {
    result: { fields: [
      { id: 71, fieldName: 'UF_CRM_10_STATE', userTypeId: 'string', editInList: 'N' },
      { id: 72, fieldName: 'UF_CRM_8_STATE', userTypeId: 'string', editInList: 'N' },
    ] },
  }
  /** Отбор переноса узнаётся по узкому `select` со старым полем; остальные списки пусты. */
  const listed = (items: Record<number, Record<string, unknown>[]>) => (params: Record<string, unknown>) => {
    const carry = (params.select as string[] | undefined)?.some(name => name.endsWith('State')) === true
    const stage = (params.filter as Record<string, unknown> | undefined)?.stageId
    return { result: { items: carry ? (items[params.entityTypeId as number] ?? []).filter(item => stage === undefined || item.stageId === stage) : [] } }
  }

  it('ГЛАВНОЕ: опросы переносятся ПОСЛЕ сохранения признака «на стадиях», шаблоны — ДО', async () => {
    // ⚠ Опросы одновременно пишет доставка: перенеси мы их раньше сохранения, опрос, пройденный
    // между переносом и сохранением, остался бы «Отправленным» навсегда. Шаблоны — наоборот:
    // прочитанные стадией до переноса, опубликованные без даты стали бы правимыми черновиками.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'userfieldconfig.list': FIELDS,
      'crm.item.list': listed({
        1040: [{ id: 1, stageId: 'DT1040_16:NEW', ufCrm10State: 'completed' }],
        1038: [{ id: 4, stageId: 'DT1038_14:NEW', ufCrm8State: 'published', ufCrm8PublishedAt: '2026-09-20', updatedTime: '2026-09-21T10:00:00+03:00' }],
      }),
    })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')

    const firstStore = p.calls.findIndex(one => one.method === 'app.option.set')
    const moved = (entityTypeId: number) => p.calls.findIndex(one => one.method === 'crm.item.update' && one.params.entityTypeId === entityTypeId)
    expect(firstStore).toBeGreaterThan(-1)
    expect(moved(1038)).toBeLessThan(firstStore)
    expect(moved(1040)).toBeGreaterThan(firstStore)
    const stored = JSON.parse(Object.values((p.calls[firstStore]!.params.options as Record<string, string>))[0]!)
    expect(stored.survey).toEqual({ ...SURVEY, categoryId: 16 })
    expect(stored.template).toEqual({ ...TEMPLATE, categoryId: 14 })
    // ⚠ Поле удаляется у ОБОИХ: у шаблона — вторым проходом после сохранения, другого места для
    // этого нет. Выпади этот проход, поле шаблона не удалялось бы никогда. Нашёл тестировщик
    // во втором круге панели PR #93: без этой строки его можно было убрать, не покраснив ни теста.
    expect(p.of('userfieldconfig.delete').map(one => one.params.id)).toEqual([72, 71])
  })

  it('ГЛАВНОЕ: шаблоны не перенеслись — этим прогоном они остаются на старом поле, ревизия ждёт', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'userfieldconfig.list': FIELDS,
      'crm.item.list': (params: Record<string, unknown>) => {
        if (params.entityTypeId === 1038 && (params.select as string[] | undefined)?.includes('ufCrm8State')) {
          throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        }
        return { result: { items: [] } }
      },
    })

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')

    const stores = p.of('app.option.set').map(one => JSON.parse(Object.values(one.params.options as Record<string, string>)[0]!))
    expect(stores[0].template).toEqual(TEMPLATE)
    expect(stores.at(-1).revision).toBe(4)
    expect(p.of('userfieldconfig.delete').map(one => one.params.id)).toEqual([71])
    // Стадии-то включены — не доделан перенос. «Стадии не включены» здесь было бы неправдой.
    // Нашёл тестировщик во втором круге панели PR #93.
    const messages = warn.mock.calls.map(([, message]) => String(message))
    expect(messages).not.toContain('штатные стадии не включены — состояние остаётся в поле «Состояние»')
    expect(messages).toContain('стадии: перенос не доделан, донастройка вернётся')
  })

  it('ГЛАВНОЕ: шаблоны, уже сохранённые со стадиями, после временного отказа на старое поле не возвращаются', async () => {
    // ⚠ Прошлый прогон мог и удалить поле: вернув шаблоны на него, мы читали бы анкеты из пустоты —
    // не выпускались бы и правились. Нашли `/review` и `/code-review` во втором круге панели PR #93.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const p = portal({
      'app.option.get': { result: JSON.stringify({ template: { ...TEMPLATE, categoryId: 14 }, survey: { ...SURVEY, categoryId: 16 }, revision: 4 }) },
      'userfieldconfig.list': FIELDS,
      'crm.item.list': (params: Record<string, unknown>) => {
        if (params.entityTypeId === 1038 && (params.select as string[] | undefined)?.includes('ufCrm8State')) {
          throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        }
        return { result: { items: [] } }
      },
    })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')

    const stores = p.of('app.option.set').map(one => JSON.parse(Object.values(one.params.options as Record<string, string>)[0]!))
    expect(stores.every(stored => stored.template.categoryId === 14)).toBe(true)
    expect(stores.at(-1).revision).toBe(4)
  })

  it('ГЛАВНОЕ: предел переноса — внутри общего бюджета: медленный портал не роняет обустройство', async () => {
    // ⚠ Первая редакция отсчитывала пятнадцать секунд переноса от конца обустройства, и на портале
    // с 0,7 с на вызов прогон упирался в общий предел: `failed`, портал в `degraded`. Нашли `/review`
    // и `/code-review` во втором круге панели PR #93 — пробой на подделке портала.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const surveys = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, stageId: 'DT1040_16:NEW', ufCrm10State: 'completed' }))
      const base = portal({ 'userfieldconfig.list': FIELDS, 'crm.item.list': listed({ 1040: surveys }) })
      const slow = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        vi.setSystemTime(Date.now() + 700)
        return base.call(method, params)
      })

      expect(await provisionWithCall(slow, 'shef.bitrix24.ru')).toBe('ok')

      const stores = base.of('app.option.set').map(one => JSON.parse(Object.values(one.params.options as Record<string, string>)[0]!))
      expect(stores.at(-1).revision).toBe(4)
      expect(base.of('userfieldconfig.delete').map(one => one.params.id)).not.toContain(71)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('в журнал — что стадии не включены и что миграция не доделана', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const p = portal({
      'crm.type.update': (params: Record<string, unknown>) => {
        if ('isStagesEnabled' in (params.fields as object)) throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        return { result: true }
      },
    })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')

    const messages = warn.mock.calls.map(([, message]) => String(message))
    expect(messages).toContain('штатные стадии не включены — состояние остаётся в поле «Состояние»')
    expect(messages).toContain('стадии настроены не до конца — ревизию не отмечаем, донастройка вернётся')
  })
})

describe('операторские команды по вебхуку', () => {
  it('ГЛАВНОЕ: воронку узнают по самому типу — сохранённых ссылок вебхуку не видно', async () => {
    // ⚠ Без этого команда переноса на портале со стадиями писала бы состояние в поле, которого
    // после миграции нет: портал молча отбросил бы запись, и анкета осталась бы «Черновиком».
    const p = portal({
      'app.option.get': () => {
        throw new Error('Application context required')
      },
      'crm.type.list': { result: { types: [
        { id: 8, entityTypeId: 1038, title: '[sh] Шаблон опроса', isStagesEnabled: 'Y' },
        { id: 10, entityTypeId: 1040, title: '[sh] Результат опросов', isStagesEnabled: 'N' },
      ] } },
    })

    const found = await findProcesses(p.call)

    expect(found.template).toEqual({ ...TEMPLATE, categoryId: 14 })
    // Тип без стадий остаётся на старом поле: воронку у него не спрашиваем.
    expect(found.survey).toEqual(SURVEY)
    expect(p.of('crm.category.list').map(one => one.params.entityTypeId)).toEqual([1038])
  })

  it('флаг стадий, присланный как `true`, — тоже «стадии включены»', async () => {
    // Сравнивая только с `'Y'`, команда на `true` молча вернулась бы к удалённому полю.
    const p = portal({
      'app.option.get': () => {
        throw new Error('Application context required')
      },
      'crm.type.list': { result: { types: [{ id: 10, entityTypeId: 1040, title: '[sh] Результат опросов', isStagesEnabled: true }] } },
    })

    expect((await findProcesses(p.call)).survey).toEqual({ ...SURVEY, categoryId: 16 })
  })

  it('ГЛАВНОЕ: посреди миграции — стадии включены, а старое поле на месте — команда отказывается работать', async () => {
    // ⚠ Приложение в этом окне может держать шаблоны на старом поле, а может уже читать их стадией;
    // вебхуку не угадать. Угадав не так, `publish:templates` переписала бы название версии, по которой
    // уже собраны ответы. Нашли `/review` и `/code-review` во втором круге панели PR #93.
    const p = portal({
      'app.option.get': () => {
        throw new Error('Application context required')
      },
      'crm.type.list': { result: { types: [{ id: 8, entityTypeId: 1038, title: '[sh] Шаблон опроса', isStagesEnabled: 'Y' }] } },
      'userfieldconfig.list': { result: { fields: [{ id: 72, fieldName: 'UF_CRM_8_STATE', userTypeId: 'string', editInList: 'N' }] } },
    })

    await expect(findProcesses(p.call)).rejects.toMatchObject({ code: 'SHEF_MIGRATION_PENDING' })
  })

  it('стадии включены, а воронки портал не назвал — пишет старым полем и говорит об этом', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const p = portal({
      'app.option.get': () => {
        throw new Error('Application context required')
      },
      'crm.type.list': { result: { types: [{ id: 8, entityTypeId: 1038, title: '[sh] Шаблон опроса', isStagesEnabled: 'Y' }] } },
      'crm.category.list': { result: { categories: [] } },
    })

    expect((await findProcesses(p.call)).template).toEqual(TEMPLATE)
    expect(warn.mock.calls.some(([, message]) => String(message).includes('воронка по умолчанию не найдена'))).toBe(true)
  })
})
