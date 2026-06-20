import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  DEV_PORTAL_ID,
  MIN_SECRET_LEN,
  resolveDashboardAuth,
  signSession,
  verifySession,
  type PortalSession
} from '../src/api/session'

const SECRET = 'test-secret-abcdefghijklmnopqrstuvwxyz-0123' // ≥ MIN_SECRET_LEN
const future = Math.floor(Date.now() / 1000) + 3600

describe('session — подписанный токен портала (#47)', () => {
  const s: PortalSession = { portalId: 'portal-42', exp: future }

  it('sign → verify round-trip возвращает исходную сессию', () => {
    expect(verifySession(signSession(s, SECRET), SECRET)).toEqual(s)
  })

  it('подделка payload (подмена portalId) отвергается', () => {
    const token = signSession(s, SECRET)
    const forged = Buffer.from(JSON.stringify({ portalId: 'evil', exp: future })).toString('base64url')
    expect(verifySession(`${forged}.${token.slice(token.indexOf('.') + 1)}`, SECRET)).toBeNull()
  })

  it('подделка подписи отвергается', () => {
    const token = signSession(s, SECRET)
    expect(verifySession(`${token.slice(0, token.indexOf('.'))}.AAAA`, SECRET)).toBeNull()
  })

  it('чужой секрет отвергается', () => {
    expect(verifySession(signSession(s, SECRET), 'other-secret-other-secret-other!')).toBeNull()
  })

  it('просрочка: exp <= now отвергается (включая ровно границу)', () => {
    const t = signSession({ portalId: 'p', exp: 1000 }, SECRET)
    expect(verifySession(t, SECRET, 999)).toEqual({ portalId: 'p', exp: 1000 }) // ещё жив
    expect(verifySession(t, SECRET, 1000)).toBeNull() // ровно граница
    expect(verifySession(t, SECRET, 1001)).toBeNull() // просрочен
  })

  it('валидная подпись, но payload не-JSON → null', () => {
    const payload = Buffer.from('not-json').toString('base64url')
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
    expect(verifySession(`${payload}.${sig}`, SECRET)).toBeNull()
  })

  it('exp = Infinity (не конечное) отвергается', () => {
    const payload = Buffer.from(JSON.stringify({ portalId: 'p', exp: Number.POSITIVE_INFINITY })).toString('base64url')
    // JSON.stringify(Infinity) → null, так что payload содержит exp:null → не number → null
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
    expect(verifySession(`${payload}.${sig}`, SECRET)).toBeNull()
  })

  it('мусор/не-строка/без точки/пустой secret/пустой portalId/число — null', () => {
    expect(verifySession('garbage', SECRET)).toBeNull()
    expect(verifySession('', SECRET)).toBeNull()
    expect(verifySession(42 as unknown, SECRET)).toBeNull()
    expect(verifySession('.sig', SECRET)).toBeNull()
    expect(verifySession('payload.', SECRET)).toBeNull()
    expect(verifySession(signSession(s, SECRET), '')).toBeNull() // пустой секрет
    expect(verifySession(signSession({ portalId: '', exp: future }, SECRET), SECRET)).toBeNull()
    const numId = Buffer.from(JSON.stringify({ portalId: 123, exp: future })).toString('base64url')
    const numSig = createHmac('sha256', SECRET).update(numId).digest('base64url')
    expect(verifySession(`${numId}.${numSig}`, SECRET)).toBeNull() // portalId не строка
  })
})

describe('resolveDashboardAuth — гейт дашборда (#47)', () => {
  const valid = signSession({ portalId: 'p1', exp: future }, SECRET)

  it('секрет + валидная сессия → ok', () => {
    const d = resolveDashboardAuth({ secret: SECRET, devOpen: false, isProduction: true }, valid)
    expect(d).toEqual({ ok: true, session: { portalId: 'p1', exp: future } })
  })

  it('секрет + нет/битый токен → 401', () => {
    expect(resolveDashboardAuth({ secret: SECRET, devOpen: false, isProduction: true }, undefined)).toEqual({ ok: false, status: 401 })
    expect(resolveDashboardAuth({ secret: SECRET, devOpen: true, isProduction: true }, 'garbage')).toEqual({ ok: false, status: 401 })
  })

  it('секрет имеет приоритет над devOpen (всё равно требует сессию)', () => {
    expect(resolveDashboardAuth({ secret: SECRET, devOpen: true, isProduction: false }, undefined)).toEqual({ ok: false, status: 401 })
  })

  it('слабый/короткий секрет → 503 (не используем слабый HMAC)', () => {
    expect('short'.length).toBeLessThan(MIN_SECRET_LEN)
    expect(resolveDashboardAuth({ secret: 'short', devOpen: false, isProduction: false }, valid)).toEqual({ ok: false, status: 503 })
  })

  it('без секрета + devOpen → dev-сессия', () => {
    const d = resolveDashboardAuth({ devOpen: true, isProduction: true }, undefined, 1000)
    expect(d).toEqual({ ok: true, session: { portalId: DEV_PORTAL_ID, exp: 1000 + 3600 } })
  })

  it('без секрета + не production → dev-сессия', () => {
    expect(resolveDashboardAuth({ devOpen: false, isProduction: false }, undefined).ok).toBe(true)
  })

  it('без секрета + production без devOpen → 503 (fail-closed)', () => {
    expect(resolveDashboardAuth({ devOpen: false, isProduction: true }, undefined)).toEqual({ ok: false, status: 503 })
  })
})
