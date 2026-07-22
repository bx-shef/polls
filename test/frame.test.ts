import { describe, expect, it, vi } from 'vitest'
import {
  isAllowedPortalDomain,
  mintPortalSession,
  parseFrameAuth,
  verifyFrameAuth,
  type FrameAuth,
  type PortalAuthenticator
} from '../src/bitrix24/frame'
import { OAuthError } from '../src/bitrix24/oauth'
import { verifySession } from '../src/api/session'

const SECRET = 'frame-secret-abcdefghijklmnopqrstuvwxyz-01' // ≥ 32

const validRaw = {
  DOMAIN: 'acme.bitrix24.ru',
  member_id: 'abc123member',
  AUTH_ID: 'access-token-xyz',
  AUTH_EXPIRES: '3600',
  PLACEMENT: 'DEFAULT'
}

describe('parseFrameAuth — недоверенный POST фрейма (#47)', () => {
  it('валидные параметры → FrameAuth (AUTH_EXPIRES коэрсится в число)', () => {
    const f = parseFrameAuth(validRaw)
    expect(f).toMatchObject({ DOMAIN: 'acme.bitrix24.ru', member_id: 'abc123member', AUTH_EXPIRES: 3600 })
  })

  it('нет AUTH_ID / member_id / мусор → null', () => {
    expect(parseFrameAuth({ ...validRaw, AUTH_ID: '' })).toBeNull()
    expect(parseFrameAuth({ ...validRaw, member_id: undefined })).toBeNull()
    expect(parseFrameAuth('garbage')).toBeNull()
    expect(parseFrameAuth({ ...validRaw, AUTH_EXPIRES: 'not-a-number' })).toBeNull()
  })

  it('AUTH_EXPIRES: optional + мягкий — ms-timestamp проходит, отрицательное/дробное → null', () => {
    expect(parseFrameAuth({ ...validRaw, AUTH_EXPIRES: undefined })?.AUTH_EXPIRES).toBeUndefined()
    expect(parseFrameAuth({ ...validRaw, AUTH_EXPIRES: '1720011727002' })?.AUTH_EXPIRES).toBe(1720011727002)
    expect(parseFrameAuth({ ...validRaw, AUTH_EXPIRES: '-1' })).toBeNull()
    expect(parseFrameAuth({ ...validRaw, AUTH_EXPIRES: '3600.5' })).toBeNull()
  })
})

describe('isAllowedPortalDomain — SSRF-гард (#47)', () => {
  it('облачные домены Bitrix24 проходят', () => {
    for (const d of ['acme.bitrix24.ru', 'ACME.bitrix24.com', 'a-b.bitrix24.de', 'shop.bitrix24.com.br']) {
      expect(isAllowedPortalDomain(d)).toBe(true)
    }
  })

  it('чужие/опасные хосты отвергаются', () => {
    for (const d of [
      'evil.com',
      'localhost',
      '127.0.0.1',
      'acme.bitrix24.ru.evil.com',
      // «Двойная TLD»-байпас: bitrix24 как ПОДДОМЕН регистрируемого атакующим домена → SSRF (был дырой).
      'foo.bitrix24.evil.com', // evil.com — атакующий; bitrix24.evil.com — его поддомен
      'foo.bitrix24.corp.io',
      'a.bitrix24.evil.co',
      'acme.bitrix24.ru/rest',
      'acme.bitrix24.ru:8080',
      'bitrix24.ru.attacker.com',
      'bitrix24.evil.com',
      'metadata.google.internal',
      'acme.bitrix24.ru.', // завершающая точка (FQDN)
      'xn--e1afmapc.bitrix24.ru', // punycode-лейбл (анти-гомоглиф)
      'XN--E1AFMAPC.bitrix24.ru', // тот же в верхнем регистре
      '-bad.bitrix24.ru', // дефис на краю лейбла
      `${'a'.repeat(254)}.bitrix24.ru`, // длиннее 253
      ''
    ]) {
      expect(isAllowedPortalDomain(d)).toBe(false)
    }
  })

  it('self-hosted переопределяет allowlist', () => {
    expect(isAllowedPortalDomain('crm.acme.local', /\.acme\.local$/)).toBe(true)
    expect(isAllowedPortalDomain('acme.bitrix24.ru', /\.acme\.local$/)).toBe(false)
  })
})

describe('verifyFrameAuth — авторитетная проверка + анти-cross-tenant (#47)', () => {
  const frame = parseFrameAuth(validRaw) as FrameAuth

  it('токен валиден и member_id совпал → portalId из авторитетного источника', async () => {
    const authenticate: PortalAuthenticator = vi.fn(async () => ({ memberId: 'abc123member' }))
    await expect(verifyFrameAuth(frame, { authenticate })).resolves.toEqual({
      portalId: 'abc123member',
      domain: 'acme.bitrix24.ru'
    })
    expect(authenticate).toHaveBeenCalledWith({ domain: 'acme.bitrix24.ru', authId: 'access-token-xyz' })
  })

  it('member_id токена ≠ заявленному в POST → отказ (cross-tenant)', async () => {
    const authenticate: PortalAuthenticator = async () => ({ memberId: 'OTHER-portal' })
    await expect(verifyFrameAuth(frame, { authenticate })).rejects.toBeInstanceOf(OAuthError)
  })

  it('authenticate вернул пустой member_id → отказ', async () => {
    const authenticate: PortalAuthenticator = async () => ({ memberId: '' })
    await expect(verifyFrameAuth(frame, { authenticate })).rejects.toBeInstanceOf(OAuthError)
  })

  it('недоверенный домен → отказ ДО вызова authenticate (нет SSRF)', async () => {
    const authenticate = vi.fn<PortalAuthenticator>(async () => ({ memberId: 'abc123member' }))
    const evil = parseFrameAuth({ ...validRaw, DOMAIN: 'evil.com' }) as FrameAuth
    await expect(verifyFrameAuth(evil, { authenticate })).rejects.toBeInstanceOf(OAuthError)
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('authenticate бросил (битый токен) → ошибка пробрасывается', async () => {
    const authenticate: PortalAuthenticator = async () => {
      throw new OAuthError('Bitrix24 отклонил токен')
    }
    await expect(verifyFrameAuth(frame, { authenticate })).rejects.toBeInstanceOf(OAuthError)
  })
})

describe('mintPortalSession — выписать сессию из подтверждённого фрейма (#47)', () => {
  it('подписанный токен верифицируется обратно с тем же portalId и сроком', () => {
    const { token, session } = mintPortalSession({ portalId: 'abc123member', domain: 'acme.bitrix24.ru' }, SECRET, 3600, 1000)
    expect(session).toEqual({ portalId: 'abc123member', exp: 1000 + 3600 })
    expect(verifySession(token, SECRET, 1000)).toEqual(session)
    expect(verifySession(token, SECRET, 1000 + 3601)).toBeNull() // просрочка
  })

  it('TTL=0 → сессия немедленно просрочена (exp == now)', () => {
    const { session, token } = mintPortalSession({ portalId: 'p', domain: 'a.bitrix24.ru' }, SECRET, 0, 1000)
    expect(session.exp).toBe(1000)
    expect(verifySession(token, SECRET, 1000)).toBeNull() // exp <= now
  })
})
