import { describe, expect, it } from 'vitest'
import { chooseChannel, shouldInvite } from '../src/domain/invitation'
import { MemoryInvitationStore } from '../src/api/invitation'
import type { CrmContext, InvitationPolicy } from '../src/domain/schema'

const policy = (over: Partial<InvitationPolicy> = {}): InvitationPolicy => ({
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

describe('api/invitation: MemoryInvitationStore', () => {
  const ctx: CrmContext = { dealId: 5994, companyId: 3986 }

  it('create → pending со снимком; peek читает; consume расходует (single-use)', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ idGen: () => 'tok' })
    const inv = s.create({ surveyKey: 'svc', versionNo: 2, context: ctx }, c.now())
    expect(inv).toMatchObject({ token: 'tok', surveyKey: 'svc', versionNo: 2, status: 'pending', context: ctx })
    expect(s.peek('tok', c.now())?.status).toBe('pending')
    const first = s.consume('tok', c.now())
    expect(first.status).toBe('ok')
    if (first.status === 'ok') expect(first.invitation.context).toEqual(ctx)
    expect(s.consume('tok', c.now())).toEqual({ status: 'replay' })
  })

  it('неизвестный токен → unknown; peek → undefined', () => {
    const c = clock()
    const s = new MemoryInvitationStore()
    expect(s.consume('нет', c.now())).toEqual({ status: 'unknown' })
    expect(s.peek('нет', c.now())).toBeUndefined()
  })

  it('TTL: после истечения приглашение вычищается (unknown)', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ ttlMs: 1000, idGen: () => 'tok' })
    s.create({ surveyKey: 'svc', versionNo: 1, context: ctx }, c.now())
    c.advance(1001)
    expect(s.peek('tok', c.now())).toBeUndefined()
    expect(s.consume('tok', c.now())).toEqual({ status: 'unknown' })
  })

  it('per-invitation ttlMs переопределяет дефолт стора', () => {
    const c = clock()
    const s = new MemoryInvitationStore({ ttlMs: 10_000, idGen: () => 'tok' })
    s.create({ surveyKey: 'svc', versionNo: 1, context: ctx, ttlMs: 500 }, c.now())
    c.advance(501)
    expect(s.peek('tok', c.now())).toBeUndefined()
  })

  it('maxPending: вытесняется самое старое приглашение (потолок памяти)', () => {
    const c = clock()
    let i = 0
    const s = new MemoryInvitationStore({ maxPending: 1, idGen: () => `tok${i++}` })
    s.create({ surveyKey: 'svc', versionNo: 1, context: ctx }, c.now())
    s.create({ surveyKey: 'svc', versionNo: 1, context: ctx }, c.now()) // вытеснит tok0
    expect(s.peek('tok0', c.now())).toBeUndefined()
    expect(s.peek('tok1', c.now())?.token).toBe('tok1')
  })
})
