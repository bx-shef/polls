import { describe, expect, it } from 'vitest'
import { chooseChannel, shouldInvite } from '../src/domain/invitation'
import { MemoryInvitationStore } from '../src/api/invitation'
import { invitationPolicySchema, type CrmContext, type InvitationPolicy } from '../src/domain/schema'

const policy = (over: Partial<InvitationPolicy> = {}): InvitationPolicy => ({
  entityType: 'deal',
  triggerStages: ['WON', 'C2:WON'],
  channelOrder: ['email', 'sms'],
  ...over
})

/** Управляемые часы — детерминированные TTL без таймеров (как в api.test). */
function clock(startIso = '2026-06-14T00:00:00.000Z'): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(startIso).getTime()
  return { now: () => new Date(t), advance: (ms) => (t += ms) }
}

describe('domain/invitation: shouldInvite (триггер задаёт опрос)', () => {
  it('стадия из triggerStages → true; иначе/пусто/undefined → false', () => {
    expect(shouldInvite('WON', policy())).toBe(true)
    expect(shouldInvite('EXECUTING', policy())).toBe(false)
    expect(shouldInvite(undefined, policy())).toBe(false)
    expect(shouldInvite('WON', policy({ triggerStages: [] }))).toBe(false)
  })
})

describe('domain/invitation: chooseChannel (порядок задаёт опрос)', () => {
  it('первый доступный по порядку channelOrder опроса', () => {
    expect(chooseChannel(['sms', 'email'], policy({ channelOrder: ['email', 'sms'] }))).toBe('email')
    expect(chooseChannel(['sms'], policy({ channelOrder: ['email', 'sms'] }))).toBe('sms')
    expect(chooseChannel(['email', 'sms'], policy({ channelOrder: ['sms', 'email'] }))).toBe('sms')
  })
  it('нет доступного канала → undefined (binding пишет пропуск в таймлайн)', () => {
    expect(chooseChannel([], policy())).toBeUndefined()
    expect(chooseChannel(['sms'], policy({ channelOrder: ['email'] }))).toBeUndefined()
  })
})

describe('domain/schema: invitationPolicySchema', () => {
  it('channelOrder с повтором канала отвергается (.refine), без повтора — ок', () => {
    expect(invitationPolicySchema.safeParse({ channelOrder: ['email', 'email'] }).success).toBe(false)
    expect(invitationPolicySchema.safeParse({ channelOrder: ['sms', 'email'] }).success).toBe(true)
  })
  it('дефолты: entityType=deal + пустые triggerStages + [email, sms]', () => {
    expect(invitationPolicySchema.parse({})).toEqual({ entityType: 'deal', triggerStages: [], channelOrder: ['email', 'sms'] })
  })
  it('entityType из перечисления: lead/contact ок; task (убран) и мусор отвергаются', () => {
    expect(invitationPolicySchema.parse({ entityType: 'lead' }).entityType).toBe('lead')
    expect(invitationPolicySchema.parse({ entityType: 'contact' }).entityType).toBe('contact')
    expect(invitationPolicySchema.safeParse({ entityType: 'task' }).success).toBe(false)
    expect(invitationPolicySchema.safeParse({ entityType: 'invoice' }).success).toBe(false)
  })
  it('spaEntityTypeId — положительное целое для смарт-процесса', () => {
    expect(invitationPolicySchema.parse({ entityType: 'spa', spaEntityTypeId: 1056 }).spaEntityTypeId).toBe(1056)
    expect(invitationPolicySchema.safeParse({ entityType: 'spa', spaEntityTypeId: 0 }).success).toBe(false)
    expect(invitationPolicySchema.safeParse({ entityType: 'spa', spaEntityTypeId: -1 }).success).toBe(false)
  })
  it('инвариант spaEntityTypeId↔entityType: spa требует id, прочие — запрещают', () => {
    // spa без id — отказ
    expect(invitationPolicySchema.safeParse({ entityType: 'spa' }).success).toBe(false)
    // не-spa с id — отказ (тихо-проглоченное поле)
    expect(invitationPolicySchema.safeParse({ entityType: 'deal', spaEntityTypeId: 42 }).success).toBe(false)
    // дефолтный deal без id — ок
    expect(invitationPolicySchema.safeParse({}).success).toBe(true)
  })
  it('linkTtlSeconds — окно [5 мин, 5 дней]; вне диапазона/дробь — отказ; не задан — undefined', () => {
    // границы включительно: 300 сек (5 мин) и 432000 сек (5 дней)
    expect(invitationPolicySchema.parse({ linkTtlSeconds: 300 }).linkTtlSeconds).toBe(300)
    expect(invitationPolicySchema.parse({ linkTtlSeconds: 432000 }).linkTtlSeconds).toBe(432000)
    // вне диапазона — parse-ошибка на границе (не тихий кламп)
    expect(invitationPolicySchema.safeParse({ linkTtlSeconds: 299 }).success).toBe(false)
    expect(invitationPolicySchema.safeParse({ linkTtlSeconds: 432001 }).success).toBe(false)
    expect(invitationPolicySchema.safeParse({ linkTtlSeconds: 0 }).success).toBe(false)
    // только целое число секунд
    expect(invitationPolicySchema.safeParse({ linkTtlSeconds: 300.5 }).success).toBe(false)
    // необязательное поле — по умолчанию отсутствует (дефолт стора приглашений на выписке)
    expect(invitationPolicySchema.parse({}).linkTtlSeconds).toBeUndefined()
  })
})

describe('api/invitation: MemoryInvitationStore', () => {
  const ctx: CrmContext = { dealId: 5994, companyId: 3986 }
  const pin = { surveyKey: 'svc', versionNo: 2 }

  it('create → pending со снимком; peek читает; consume по верному пину расходует (single-use)', async () => {
    const c = clock()
    const s = new MemoryInvitationStore({ idGen: () => 'tok' })
    const inv = await s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    expect(inv).toMatchObject({ token: 'tok', surveyKey: 'svc', versionNo: 2, status: 'pending', context: ctx })
    expect((await s.peek('tok', c.now()))?.status).toBe('pending')
    const first = await s.consume('tok', pin, c.now())
    expect(first.status).toBe('ok')
    if (first.status === 'ok') expect(first.invitation.context).toEqual(ctx)
    expect(await s.consume('tok', pin, c.now())).toEqual({ status: 'replay' })
  })

  it('peek после consume → undefined (использованное приглашение наружу не отдаём)', async () => {
    const c = clock()
    const s = new MemoryInvitationStore({ idGen: () => 'tok' })
    await s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    await s.consume('tok', pin, c.now())
    expect(await s.peek('tok', c.now())).toBeUndefined()
  })

  it('чужой пин → mismatch БЕЗ расхода токена (верный пин затем проходит)', async () => {
    const c = clock()
    const s = new MemoryInvitationStore({ idGen: () => 'tok' })
    await s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    expect(await s.consume('tok', { surveyKey: 'svc', versionNo: 9 }, c.now())).toEqual({ status: 'mismatch' }) // чужая версия
    expect(await s.consume('tok', { surveyKey: 'other', versionNo: 2 }, c.now())).toEqual({ status: 'mismatch' }) // чужой опрос
    expect((await s.consume('tok', pin, c.now())).status).toBe('ok') // не сожжён
  })

  it('неизвестный токен → unknown; peek → undefined', async () => {
    const c = clock()
    const s = new MemoryInvitationStore()
    expect(await s.consume('нет', pin, c.now())).toEqual({ status: 'unknown' })
    expect(await s.peek('нет', c.now())).toBeUndefined()
  })

  it('TTL: replay различим до истечения, после — unknown (окно как у nonce)', async () => {
    const c = clock()
    const s = new MemoryInvitationStore({ ttlMs: 1000, idGen: () => 'tok' })
    await s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    expect((await s.consume('tok', pin, c.now())).status).toBe('ok')
    expect(await s.consume('tok', pin, c.now())).toEqual({ status: 'replay' }) // в окне TTL
    c.advance(1001)
    expect(await s.consume('tok', pin, c.now())).toEqual({ status: 'unknown' }) // окно истекло
  })

  it('протухшее НЕиспользованное приглашение → unknown (peek и consume)', async () => {
    const c = clock()
    const s = new MemoryInvitationStore({ ttlMs: 1000, idGen: () => 'tok' })
    await s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    c.advance(1001)
    expect(await s.peek('tok', c.now())).toBeUndefined()
    expect(await s.consume('tok', pin, c.now())).toEqual({ status: 'unknown' })
  })

  it('per-invitation ttlMs переопределяет дефолт стора (peek и consume)', async () => {
    const c = clock()
    const s = new MemoryInvitationStore({ ttlMs: 10_000, idGen: () => 'tok' })
    await s.create({ surveyKey: 'svc', versionNo: 2, context: ctx, ttlMs: 500 }, c.now())
    c.advance(501)
    expect(await s.peek('tok', c.now())).toBeUndefined()
    expect(await s.consume('tok', pin, c.now())).toEqual({ status: 'unknown' })
  })

  it('maxPending: вытесняется самое старое приглашение (потолок памяти)', async () => {
    const c = clock()
    let i = 0
    const s = new MemoryInvitationStore({ maxPending: 1, idGen: () => `tok${i++}` })
    await s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    await s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now()) // вытеснит tok0
    expect(await s.peek('tok0', c.now())).toBeUndefined()
    expect((await s.peek('tok1', c.now()))?.token).toBe('tok1')
  })
})
