import { describe, expect, it } from 'vitest'
import { signSession, verifySession, type PortalSession } from '../src/api/session'

const SECRET = 'test-secret-0123456789'
const future = Math.floor(Date.now() / 1000) + 3600

describe('session — подписанный токен портала (#47)', () => {
  const s: PortalSession = { portalId: 'portal-42', exp: future }

  it('sign → verify round-trip возвращает исходную сессию', () => {
    expect(verifySession(signSession(s, SECRET), SECRET)).toEqual(s)
  })

  it('подделка payload (подмена portalId) отвергается', () => {
    const token = signSession(s, SECRET)
    const forged = Buffer.from(JSON.stringify({ portalId: 'evil', exp: future })).toString('base64url')
    const tampered = `${forged}.${token.slice(token.indexOf('.') + 1)}`
    expect(verifySession(tampered, SECRET)).toBeNull()
  })

  it('подделка подписи отвергается', () => {
    const token = signSession(s, SECRET)
    expect(verifySession(`${token.slice(0, token.indexOf('.'))}.AAAA`, SECRET)).toBeNull()
  })

  it('чужой секрет отвергается', () => {
    expect(verifySession(signSession(s, SECRET), 'other-secret')).toBeNull()
  })

  it('просроченная сессия отвергается (exp <= now)', () => {
    const expired = signSession({ portalId: 'p', exp: 1000 }, SECRET)
    expect(verifySession(expired, SECRET, 1001)).toBeNull()
    expect(verifySession(expired, SECRET, 999)).toEqual({ portalId: 'p', exp: 1000 })
  })

  it('мусор/не-строка/без точки/пустой portalId — null', () => {
    expect(verifySession('garbage', SECRET)).toBeNull()
    expect(verifySession('', SECRET)).toBeNull()
    expect(verifySession(42 as unknown, SECRET)).toBeNull()
    expect(verifySession('.sig', SECRET)).toBeNull()
    expect(verifySession('payload.', SECRET)).toBeNull()
    expect(verifySession(signSession({ portalId: '', exp: future }, SECRET), SECRET)).toBeNull()
  })
})
