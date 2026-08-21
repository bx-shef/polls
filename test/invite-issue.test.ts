import { describe, expect, it, vi } from 'vitest'
import { makeInviteIssue, type InviteIssueDeps } from '../server/utils/invite-issue'
import { createKeySerializer } from '../src/api/serial-by-key'
import { MemoryInvitationStore, type InvitationStore } from '../src/api/invitation'
import type { PortalClient, CallResult } from '../src/bitrix24/client'
import type { CrmContext } from '../src/domain/schema'

/**
 * Проводка выписки целиком — ИСПОЛНЯЕМАЯ, с фейковым порталом.
 *
 * ⚠️ Пока эта работа жила замыканием внутри `defineEventHandler`, её нельзя было запустить вовсе:
 * тест «гроздь → одно приглашение» в `deal-update.test.ts` подменяет `issue` заглушкой, то есть
 * проверяет проводку ДО неё, а не то, что правило соединено с настоящими REST-вызовами.
 */

/** Фейк портала: помнит созданные дела и отвечает на list/get/update как настоящий. */
function fakePortal(over: { failAdd?: boolean; listReturns?: () => unknown[]; markerAccepted?: boolean } = {}) {
  const markerAccepted = over.markerAccepted ?? true
  const activities: Array<{ ID: number; COMPLETED: string; ORIGINATOR_ID?: string; ORIGIN_ID?: string }> = []
  let seq = 0
  const calls: string[] = []
  const make = vi.fn(async (opts: { method: string; params?: Record<string, unknown> }): Promise<CallResult> => {
    calls.push(opts.method)
    const p = (opts.params ?? {}) as Record<string, never>
    let result: unknown
    if (opts.method === 'crm.activity.configurable.add') {
      if (over.failAdd) throw new Error('ERROR_WRONG_CONTEXT')
      const fields = (p as unknown as { fields?: { originatorId?: string; originId?: string } }).fields ?? {}
      const row = { ID: ++seq + 100, COMPLETED: 'N', ...(markerAccepted
        ? { ORIGINATOR_ID: fields.originatorId, ORIGIN_ID: fields.originId }
        : {}) }
      activities.push(row)
      result = row.ID
    } else if (opts.method === 'crm.activity.list') {
      const f = (p as unknown as { filter: Record<string, unknown> }).filter
      result = over.listReturns
        ? over.listReturns()
        : activities.filter((a) => a.ORIGINATOR_ID === f.ORIGINATOR_ID && a.ORIGIN_ID === f.ORIGIN_ID)
    } else if (opts.method === 'crm.activity.get') {
      result = activities.find((a) => a.ID === (p as unknown as { id: number }).id) ?? null
    } else if (opts.method === 'crm.activity.update') {
      const { id, fields } = p as unknown as { id: number; fields: { ORIGINATOR_ID: string; ORIGIN_ID: string } }
      const row = activities.find((a) => a.ID === id)
      if (row) { row.ORIGINATOR_ID = fields.ORIGINATOR_ID; row.ORIGIN_ID = fields.ORIGIN_ID }
      result = true
    }
    return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
  })
  const client: PortalClient = { actions: { v2: { call: { make } } } }
  return { client, activities, calls }
}

const CONTEXT: CrmContext = { dealId: 759, dealStageId: 'C1:WON' }
const ARGS = {
  surveyKey: 'csat_postdeal',
  title: 'Оценка после сделки',
  versionNo: 2,
  context: CONTEXT,
  ttlMs: undefined,
  now: new Date('2026-08-20T10:05:00Z')
}
const CTX = { transition: { id: '4242', at: new Date('2026-08-20T10:00:00Z') }, memberId: 'm-1' }

/** Шим: тесты говорят про `store`/`invitations`, а деп — резолвер тенанта портала (#49). */
type DepsOver = Omit<Partial<InviteIssueDeps>, 'tenant'> & {
  store?: { hasResponseSince: (...args: never[]) => Promise<boolean> }
  invitations?: InvitationStore
  tenant?: InviteIssueDeps['tenant']
}

function deps(over: DepsOver = {}): InviteIssueDeps & { logs: Array<[string, string, Record<string, unknown>]> } {
  const logs: Array<[string, string, Record<string, unknown>]> = []
  const portal = fakePortal()
  const { store: overStore, invitations: overInvitations, tenant: overTenant, ...rest } = over
  const tenant = {
    store: (overStore ?? { hasResponseSince: () => Promise.resolve(false) }) as Awaited<ReturnType<InviteIssueDeps['tenant']>>['store'],
    invitations: overInvitations ?? new MemoryInvitationStore()
  }
  const base: InviteIssueDeps = {
    portalClient: () => Promise.resolve(portal.client),
    tenant: overTenant ?? (() => Promise.resolve(tenant)),
    serializer: createKeySerializer(),
    baseUrl: 'https://polls.example',
    log: {
      info: (e, f) => logs.push(['info', e, f]),
      warn: (e, f) => logs.push(['warn', e, f])
    },
    ...rest
  }
  return { ...base, logs }
}

describe('выписка приглашения — проводка с фейковым порталом', () => {
  it('первое событие: приглашение + дело + маркер принят', async () => {
    const portal = fakePortal()
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const r = await makeInviteIssue(CTX, d)(ARGS)
    expect(r?.token).toBeTruthy()
    expect(portal.activities).toHaveLength(1)
    const activity = d.logs.find((l) => l[1] === 'b24_invite_activity')
    expect(activity?.[0]).toBe('info')
    expect(activity?.[2]).toMatchObject({ markerFix: 'already', markerVisible: 'yes' })
  })

  it('ГРОЗДЬ из четырёх событий одного перехода → ОДНО дело и ОДНО приглашение', async () => {
    // Ровно дефект #138: менеджер тянет сделку в стадию → портал требует дозаполнить поля →
    // сохранение → автоматизация стадии дописывает своё. Все четыре приходят сюда.
    const portal = fakePortal()
    const invitations = new MemoryInvitationStore()
    const d = deps({ portalClient: () => Promise.resolve(portal.client), invitations })
    const issue = makeInviteIssue(CTX, d)
    const results = await Promise.all([issue(ARGS), issue(ARGS), issue(ARGS), issue(ARGS)])
    expect(portal.activities, 'на один переход создано больше одного дела').toHaveLength(1)
    expect(results.filter(Boolean), 'выписано больше одного приглашения').toHaveLength(1)
    expect(d.logs.filter((l) => l[1] === 'b24_invite_dedup')).toHaveLength(3)
  })

  it('маркер не принят при создании → дописан, и дело всё равно находится', async () => {
    // `configurable.add` вебхуку недоступен, поэтому «примет ли он поля маркера» до установки
    // неизвестно. Ставка на «примет» стоила бы второго приглашения каждой сделке.
    const portal = fakePortal({ markerAccepted: false })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const issue = makeInviteIssue(CTX, d)
    await issue(ARGS)
    const first = d.logs.find((l) => l[1] === 'b24_invite_activity')
    expect(first?.[2]).toMatchObject({ markerFix: 'repaired', markerVisible: 'yes' })
    expect(await issue(ARGS), 'после починки маркера гроздь снова пробила защиту').toBeUndefined()
  })

  it('поиск НЕ видит созданное дело → предупреждение в логе, а не тишина', async () => {
    // Если `crm.activity.list` не возвращает настраиваемые дела, защита — no-op. Без этой строки в
    // логе она выглядела бы работающей: `markerFix: already` при 2–4 письмах клиенту.
    const portal = fakePortal({ listReturns: () => [] })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    await makeInviteIssue(CTX, d)(ARGS)
    const activity = d.logs.find((l) => l[1] === 'b24_invite_activity')
    expect(activity?.[0]).toBe('warn')
    expect(activity?.[2]).toMatchObject({ markerVisible: 'no' })
  })

  it('создание дела упало → живого токена НЕ остаётся', async () => {
    // Иначе в сторе копилась бы годная ссылка со снимком CRM (там ПДн), которую никто никогда не
    // увидит, — и по одной на каждое событие грозди.
    const portal = fakePortal({ failAdd: true })
    // Перехватываем токен: наружу он не отдаётся (выписка упала), а проверить надо именно его.
    const inner = new MemoryInvitationStore()
    const minted: string[] = []
    const invitations = {
      ...inner,
      create: async (...a: Parameters<MemoryInvitationStore['create']>) => {
        const inv = await inner.create(...a)
        minted.push(inv.token)
        return inv
      },
      peek: (...a: Parameters<MemoryInvitationStore['peek']>) => inner.peek(...a),
      consume: (...a: Parameters<MemoryInvitationStore['consume']>) => inner.consume(...a)
    }
    const d = deps({ portalClient: () => Promise.resolve(portal.client), invitations })
    await expect(makeInviteIssue(CTX, d)(ARGS)).rejects.toThrow('ERROR_WRONG_CONTEXT')
    expect(d.logs.find((l) => l[1] === 'b24_invite_activity_fail')?.[0]).toBe('warn')
    expect(minted, 'токен вообще не выписывался — тест проверяет не то').toHaveLength(1)
    // `peek` отдаёт только ЖИВЫЕ приглашения: погашенный токен → undefined.
    expect(
      await inner.peek(minted[0]!, new Date('2026-08-20T10:06:00Z')),
      'приглашение осталось живым, хотя доставить его нечем'
    ).toBeUndefined()
  })

  it('нет ключа перехода → приглашение НЕ выписывается, и это видно в логе', async () => {
    const invitations = new MemoryInvitationStore()
    const d = deps({ invitations })
    const r = await makeInviteIssue({ transition: {}, memberId: 'm-1' }, d)(ARGS)
    expect(r).toBeUndefined()
    expect(d.logs.find((l) => l[1] === 'b24_invite_undelivered')?.[2])
      .toMatchObject({ reason: 'нет ID перехода' })
  })

  it('нет момента перехода → тоже не выписываем (точка отсчёта «ответил ли» неизвестна)', async () => {
    const d = deps()
    expect(await makeInviteIssue({ transition: { id: '4242' }, memberId: 'm-1' }, d)(ARGS)).toBeUndefined()
    expect(d.logs.find((l) => l[1] === 'b24_invite_undelivered')?.[2])
      .toMatchObject({ reason: 'нет момента перехода' })
  })

  it('клиент ответил после перехода, дело закрыто → молчим', async () => {
    const portal = fakePortal()
    const d = deps({
      portalClient: () => Promise.resolve(portal.client),
      store: { hasResponseSince: () => Promise.resolve(true) }
    })
    const issue = makeInviteIssue(CTX, d)
    await issue(ARGS)
    portal.activities.forEach((a) => { a.COMPLETED = 'Y' })
    expect(await issue(ARGS)).toBeUndefined()
    expect(d.logs.filter((l) => l[1] === 'b24_invite_dedup').at(-1)?.[2]).toMatchObject({ reason: 'answered' })
  })

  it('дело закрыто, ответа нет → зовём снова', async () => {
    const portal = fakePortal()
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const issue = makeInviteIssue(CTX, d)
    await issue(ARGS)
    portal.activities.forEach((a) => { a.COMPLETED = 'Y' })
    expect(await issue(ARGS)).toBeTruthy()
    expect(portal.activities).toHaveLength(2)
  })

  it('ссылка в деле строится от НАСТРОЕННОГО домена приложения', async () => {
    const portal = fakePortal()
    const d = deps({ portalClient: () => Promise.resolve(portal.client), baseUrl: 'https://polls.bx-shef.by' })
    const r = await makeInviteIssue(CTX, d)(ARGS)
    const params = portal.client.actions.v2.call.make as unknown as { mock: { calls: Array<[{ method: string; params: Record<string, unknown> }]> } }
    const add = params.mock.calls.find((c) => c[0].method === 'crm.activity.configurable.add')![0].params
    const layout = (add as { layout: { body: { blocks: { surveyLink: { properties: { value: string } } } } } }).layout
    expect(layout.body.blocks.surveyLink.properties.value)
      .toBe(`https://polls.bx-shef.by/s/csat_postdeal?token=${r!.token}`)
  })
})
