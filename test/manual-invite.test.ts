import { describe, expect, it, vi } from 'vitest'
import { manualInvite, type ManualInviteDeps } from '../server/utils/manual-invite'
import { MemoryInvitationStore } from '../src/api/invitation'
import { INVITE_ORIGINATOR, markerMatchesSurvey } from '../src/bitrix24/invite-delivery'
import type { PortalClient, CallResult } from '../src/bitrix24/client'
import type { CompiledVersion, CrmContext } from '../src/domain/schema'
import type { IStore } from '../src/store/types'

/**
 * Ручной запуск опроса из карточки сделки (#176) — ИСПОЛНЯЕМО, с фейковым порталом.
 *
 * Проверяется ПОВЕДЕНИЕ, а не форма: «висит открытое дело → второй ссылки нет», «force создаёт
 * осознанно», «отказ создания дела НЕ отбирает у человека уже выданную ссылку». Покрытие в проекте
 * считается только по `src/**`, то есть `server/**` порогом не гейтится вовсе.
 */
const CONTEXT: CrmContext = { dealId: 759, responsibleId: 12 }
const SURVEY = 'csat_postdeal'

/** Фейк портала: помнит дела, честно отвечает на list/add/get/update. */
function fakePortal(existing: Array<Record<string, unknown>> = [], over: {
  failAdd?: boolean
  failList?: boolean
  /** `configurable.add` принял вызов, но поля маркера проигнорировал (вживую не сверено). */
  dropMarker?: boolean
} = {}) {
  const rows = new Map(existing.map((a) => [a.ID as number, { COMPLETED: 'N', ...a }]))
  let nextId = 1000
  const calls: string[] = []
  const make = vi.fn(async (opts: { method: string; params?: Record<string, unknown> }): Promise<CallResult> => {
    calls.push(opts.method)
    let result: unknown
    if (opts.method === 'crm.activity.list') {
      if (over.failList) throw new Error('портал недоступен')
      const f = (opts.params as { filter?: Record<string, unknown> } | undefined)?.filter ?? {}
      result = [...rows.values()].filter((r) =>
        (f.COMPLETED === undefined || r.COMPLETED === f.COMPLETED)
        && (f.ORIGIN_ID === undefined || r.ORIGIN_ID === f.ORIGIN_ID))
    } else if (opts.method === 'crm.activity.configurable.add') {
      if (over.failAdd) throw new Error('нет прав на дела')
      const p = opts.params as { fields?: Record<string, unknown>; ownerId?: number }
      const id = nextId++
      rows.set(id, {
        ID: id,
        COMPLETED: 'N',
        OWNER_ID: p.ownerId,
        ...(over.dropMarker ? {} : { ORIGINATOR_ID: p.fields?.originatorId, ORIGIN_ID: p.fields?.originId })
      })
      result = id
    } else if (opts.method === 'crm.activity.get') {
      result = rows.get((opts.params as { id: number }).id) ?? null
    } else if (opts.method === 'crm.activity.update') {
      const p = opts.params as { id: number; fields: Record<string, unknown> }
      Object.assign(rows.get(p.id) ?? {}, p.fields)
      result = true
    }
    return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
  })
  const client: PortalClient = { actions: { v2: { call: { make } } } }
  return { client, rows, calls }
}

const version = { versionNo: 2, title: 'Оценка после сделки' } as CompiledVersion
const store: Pick<IStore, 'currentVersion'> = { currentVersion: async () => version }
const noVersion: Pick<IStore, 'currentVersion'> = { currentVersion: async () => undefined }

function deps(client: PortalClient, over: Partial<ManualInviteDeps> = {}) {
  const logs: Array<[string, string, Record<string, unknown>]> = []
  const d: ManualInviteDeps = {
    client,
    store,
    invitations: new MemoryInvitationStore(),
    baseUrl: 'https://polls.example.com',
    log: { info: (e, f) => logs.push(['info', e, f]), warn: (e, f) => logs.push(['warn', e, f]) },
    now: new Date('2026-08-21T10:00:00.000Z'),
    ...over
  }
  return { ...d, logs }
}

const row = (id: number, originId: string, completed = 'N'): Record<string, unknown> =>
  ({ ID: id, ORIGINATOR_ID: INVITE_ORIGINATOR, ORIGIN_ID: originId, COMPLETED: completed })

describe('ручной запуск из карточки сделки: «уже приглашали?» (#176)', () => {
  it('открытое дело по ЭТОМУ опросу → второй ссылки нет', async () => {
    // ⚠️ Ровно тот дефект задачи: менеджер не заметил блок в таймлайне и нажал «Создать ссылку».
    const p = fakePortal([row(7, `stage:100:${SURVEY}`)])
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    expect(res).toEqual({ kind: 'existing', activityIds: [7] })
    expect(p.calls, 'выписка всё-таки пошла').not.toContain('crm.activity.configurable.add')
    expect(d.logs.find((l) => l[1] === 'b24_manual_dedup')).toBeDefined()
  })

  it('видит и АВТОМАТИЧЕСКОЕ дело, и созданное РУКАМИ — иначе пути слепы друг к другу', async () => {
    for (const originId of [`stage:100:${SURVEY}`, `manual:1787220000:${SURVEY}`]) {
      const p = fakePortal([row(7, originId)])
      const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client))
      expect(res.kind, originId).toBe('existing')
    }
  })

  it('дело по ДРУГОМУ опросу и ЗАКРЫТОЕ дело не мешают: это не тот повод', async () => {
    const p = fakePortal([row(7, 'stage:100:nps'), row(8, `stage:101:${SURVEY}`, 'Y')])
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client))
    expect(res.kind).toBe('created')
  })

  it('дело-РЕЗУЛЬТАТ не читается как приглашение', async () => {
    // Префиксы разведены намеренно: совпади они, запись о результате гасила бы новый опрос.
    const p = fakePortal([row(7, 'result:r-1')])
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client))
    expect(res.kind).toBe('created')
  })

  it('force → выписываем ОСОЗНАННО, даже когда дело висит', async () => {
    const p = fakePortal([row(7, `stage:100:${SURVEY}`)])
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT, force: true }, deps(p.client))
    expect(res.kind).toBe('created')
    // ⚠️ И поиска быть не должно: при `force` его ответ ничего не меняет, а REST портала не бесплатен.
    expect(p.calls).not.toContain('crm.activity.list')
  })

  it('отказ ПОИСКА не запирает человека: выписываем, но говорим об этом в лог', async () => {
    // Упереть осознанное действие в недоступность CRM хуже, чем изредка допустить дубль, который
    // менеджер видит своими глазами в той же карточке.
    const p = fakePortal([], { failList: true })
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    expect(res.kind).toBe('created')
    expect(d.logs.find((l) => l[1] === 'b24_manual_lookup_fail')?.[0]).toBe('warn')
  })
})

describe('ручной запуск: что именно создаётся (#176)', () => {
  it('приглашение + дело в таймлайне с маркером `manual:`, и маркер узнаётся своими же', async () => {
    const p = fakePortal()
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    if (res.kind !== 'created') throw new Error('unreachable')
    expect(res.url).toBe(`https://polls.example.com/s/${SURVEY}?token=${res.token}`)
    expect(await d.invitations.peek(res.token, new Date('2026-08-21T10:00:01Z'))).toBeDefined()

    const created = [...p.rows.values()].find((r) => r.ID === res.activityId)
    expect(created?.OWNER_ID, 'дело село не в ту сделку').toBe(759)
    expect(created?.ORIGINATOR_ID).toBe(INVITE_ORIGINATOR)
    // ⚠️ Несущее: не узнавай мы свой ручной маркер, дело не участвовало бы ни в дедупе следующего
    // нажатия, ни в закрытии при ответе (#177) — висело бы в карточке открытым вечно.
    expect(markerMatchesSurvey(created?.ORIGIN_ID, SURVEY)).toBe(true)
    expect(String(created?.ORIGIN_ID)).toMatch(/^manual:\d+:csat_postdeal$/)
  })

  it('маркер, не принятый `configurable.add`, ДОПИСЫВАЕТСЯ — иначе дело не найдётся никем', async () => {
    const p = fakePortal([], { dropMarker: true })
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    if (res.kind !== 'created') throw new Error('unreachable')
    expect(markerMatchesSurvey([...p.rows.values()].find((r) => r.ID === res.activityId)?.ORIGIN_ID, SURVEY)).toBe(true)
    expect(d.logs.find((l) => l[1] === 'b24_manual_activity')?.[2].markerFix).toBe('repaired')
  })

  it('отказ создания ДЕЛА не отбирает у человека ссылку — она уже едет ему ответом', async () => {
    // ⚠️ Единственное отличие от автопути, и оно осознанное: там дело И ЕСТЬ канал доставки, поэтому
    // при отказе токен гасится (ссылка без дела недостижима никому). Здесь ссылку получает менеджер
    // в самом виджете — гасить её значило бы отобрать сделанную работу из-за неудавшейся отметки.
    const p = fakePortal([], { failAdd: true })
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    if (res.kind !== 'created') throw new Error('unreachable')
    expect(res.activityId).toBeUndefined()
    expect(await d.invitations.peek(res.token, new Date('2026-08-21T10:00:01Z')), 'токен погашен').toBeDefined()
    expect(d.logs.find((l) => l[1] === 'b24_manual_activity_fail')?.[0]).toBe('warn')
  })

  it('нет опубликованной версии → ничего не создано и ничего не записано в таймлайн', async () => {
    const p = fakePortal()
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client, { store: noVersion }))
    expect(res).toEqual({ kind: 'unpublished' })
    expect(p.calls).not.toContain('crm.activity.configurable.add')
  })
})
