import { afterEach, describe, expect, it, vi } from 'vitest'
import { carryStatesToStages, provisionSmartProcesses } from '../../server/b24/provision'
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
  })
})

describe('перенос старого поля «Состояние»', () => {
  const STAGED = { template: { ...TEMPLATE, categoryId: 14 }, survey: { ...SURVEY, categoryId: 16 } }
  const FIELDS = {
    result: { fields: [
      { id: 71, fieldName: 'UF_CRM_10_STATE', userTypeId: 'string', editInList: 'N' },
      { id: 72, fieldName: 'UF_CRM_8_STATE', userTypeId: 'string', editInList: 'N' },
    ] },
  }

  it('ГЛАВНОЕ: переводит по старому полю и только потом удаляет поле', async () => {
    const p = portal({
      'crm.item.list': (params: Record<string, unknown>) => ({ result: { items: params.entityTypeId === 1040
        ? [
            { id: 1, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' },
            { id: 2, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'sent' },
            { id: 3, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'revoked' },
          ]
        : [{ id: 4, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: null, updatedTime: '2026-09-21T10:00:00+03:00' }] } }),
      'userfieldconfig.list': FIELDS,
    })

    const outcome = await carryStatesToStages(p.call, STAGED, { template: false, survey: false })

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

  it('ГЛАВНОЕ: не перевёлся хоть один элемент — поле остаётся, иначе его состояние пропало бы', async () => {
    const p = portal({
      'crm.item.list': (params: Record<string, unknown>) => ({ result: { items: params.entityTypeId === 1040
        ? [{ id: 1, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' }]
        : [] } }),
      'crm.item.update': () => {
        throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      },
      'userfieldconfig.list': FIELDS,
    })

    const outcome = await carryStatesToStages(p.call, STAGED, { template: false, survey: false })

    expect(p.of('userfieldconfig.delete').map(one => one.params.id)).toEqual([72])
    expect(outcome.settled).toBe(false)
  })

  it('листает все страницы, пока портал отдаёт следующую', async () => {
    const p = portal({
      'crm.item.list': (params: Record<string, unknown>) => {
        if (params.entityTypeId !== 1040) return { result: { items: [] } }
        return params.start === 50
          ? { result: { items: [{ id: 60, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' }] } }
          : { result: { items: [{ id: 5, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' }] }, next: 50 }
      },
    })

    await carryStatesToStages(p.call, STAGED, { template: false, survey: false })

    expect(p.of('crm.item.update').map(one => one.params.id)).toEqual([5, 60])
  })

  it('созданный этим запуском и оставшийся на старом поле — не трогает вовсе', async () => {
    const p = portal()

    await carryStatesToStages(p.call, { template: TEMPLATE, survey: { ...SURVEY, categoryId: 16 } }, { template: false, survey: true })

    expect(p.calls).toEqual([])
  })
})

describe('порядок миграции целиком', () => {
  it('ГЛАВНОЕ: признак «на стадиях» сохраняется РАНЬШЕ, чем переносятся элементы', async () => {
    // ⚠ Пока признак не сохранён, приложение пишет состояние старым полем. Перенеси мы элементы
    // раньше, опрос, пройденный между переносом и сохранением, остался бы «Отправленным» навсегда.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'crm.item.list': (params: Record<string, unknown>) => ({ result: { items: params.entityTypeId === 1040
        ? [{ id: 1, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' }]
        : [] } }),
    })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')

    const firstStore = p.calls.findIndex(one => one.method === 'app.option.set')
    const firstMove = p.calls.findIndex(one => one.method === 'crm.item.update')
    expect(firstStore).toBeGreaterThan(-1)
    expect(firstMove).toBeGreaterThan(firstStore)
    const stored = JSON.parse(Object.values((p.calls[firstStore]!.params.options as Record<string, string>))[0]!)
    expect(stored.survey).toEqual({ ...SURVEY, categoryId: 16 })
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
})
