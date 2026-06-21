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
  it('entityType из перечисления: lead/spa/task ок, мусор отвергается', () => {
    expect(invitationPolicySchema.parse({ entityType: 'lead' }).entityType).toBe('lead')
    expect(invitationPolicySchema.parse({ entityType: 'task' }).entityType).toBe('task')
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
})

describe('api/invitation: MemoryInvitationStore', () => {
  const ctx: CrmContext = { dealId: 5994, companyId: 3986 }
  const pin = { surveyKey: 'svc', versionNo: 2 }

  it('create → pending со снимком; peek читает; consume по верному пину расходует (single-use)', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ idGen: () => 'tok' })
    const inv = s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    expect(inv).toMatchObject({ token: 'tok', surveyKey: 'svc', versionNo: 2, status: 'pending', context: ctx })
    expect(s.peek('tok', c.now())?.status).toBe('pending')
    const first = s.consume('tok', pin, c.now())
    expect(first.status).toBe('ok')
    if (first.status === 'ok') expect(first.invitation.context).toEqual(ctx)
    expect(s.consume('tok', pin, c.now())).toEqual({ status: 'replay' })
  })

  it('peek после consume → undefined (использованное приглашение наружу не отдаём)', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ idGen: () => 'tok' })
    s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    s.consume('tok', pin, c.now())
    expect(s.peek('tok', c.now())).toBeUndefined()
  })

  it('чужой пин → mismatch БЕЗ расхода токена (верный пин затем проходит)', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ idGen: () => 'tok' })
    s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    expect(s.consume('tok', { surveyKey: 'svc', versionNo: 9 }, c.now())).toEqual({ status: 'mismatch' }) // чужая версия
    expect(s.consume('tok', { surveyKey: 'other', versionNo: 2 }, c.now())).toEqual({ status: 'mismatch' }) // чужой опрос
    expect(s.consume('tok', pin, c.now()).status).toBe('ok') // не сожжён
  })

  it('неизвестный токен → unknown; peek → undefined', () => {
    const c = clock()
    const s = new MemoryInvitationStore()
    expect(s.consume('нет', pin, c.now())).toEqual({ status: 'unknown' })
    expect(s.peek('нет', c.now())).toBeUndefined()
  })

  it('TTL: replay различим до истечения, после — unknown (окно как у nonce)', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ ttlMs: 1000, idGen: () => 'tok' })
    s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    expect(s.consume('tok', pin, c.now()).status).toBe('ok')
    expect(s.consume('tok', pin, c.now())).toEqual({ status: 'replay' }) // в окне TTL
    c.advance(1001)
    expect(s.consume('tok', pin, c.now())).toEqual({ status: 'unknown' }) // окно истекло
  })

  it('протухшее НЕиспользованное приглашение → unknown (peek и consume)', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ ttlMs: 1000, idGen: () => 'tok' })
    s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    c.advance(1001)
    expect(s.peek('tok', c.now())).toBeUndefined()
    expect(s.consume('tok', pin, c.now())).toEqual({ status: 'unknown' })
  })

  it('per-invitation ttlMs переопределяет дефолт стора (peek и consume)', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ ttlMs: 10_000, idGen: () => 'tok' })
    s.create({ surveyKey: 'svc', versionNo: 2, context: ctx, ttlMs: 500 }, c.now())
    c.advance(501)
    expect(s.peek('tok', c.now())).toBeUndefined()
    expect(s.consume('tok', pin, c.now())).toEqual({ status: 'unknown' })
  })

  it('maxPending: вытесняется самое старое приглашение (потолок памяти)', () => {
    const c = clock()
    let i = 0
    const s = new MemoryInvitationStore({ maxPending: 1, idGen: () => `tok${i++}` })
    s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now()) // вытеснит tok0
    expect(s.peek('tok0', c.now())).toBeUndefined()
    expect(s.peek('tok1', c.now())?.token).toBe('tok1')
  })
})
