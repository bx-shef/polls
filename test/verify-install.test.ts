import { describe, expect, it } from 'vitest'
import { verifyInstallMember, type RefreshCapable } from '../src/bitrix24/verify-install'
import { OAuthError, type OAuthTokens } from '../src/bitrix24/oauth'

const tokens = (over: Partial<OAuthTokens> = {}): OAuthTokens => ({
  memberId: 'm-1',
  accessToken: 'AT-new',
  refreshToken: 'RT-new',
  expiresAt: '2026-06-13T11:00:00.000Z',
  domain: 'p.b24',
  ...over
})

const oauthReturning = (t: OAuthTokens): RefreshCapable => ({ refresh: () => Promise.resolve(t) })
const oauthThrowing = (e: unknown): RefreshCapable => ({ refresh: () => Promise.reject(e) })

describe('verifyInstallMember (§2.3 анти install-poisoning)', () => {
  it('authoritative member_id совпал → ok, отдаёт РОТИРОВАННЫЙ грант', async () => {
    const rotated = tokens({ memberId: 'm-1', accessToken: 'AT-rot', refreshToken: 'RT-rot' })
    expect(await verifyInstallMember('m-1', 'RT-posted', oauthReturning(rotated))).toEqual({ ok: true, tokens: rotated })
  })

  it('authoritative member_id ≠ заявленному → 403 member_mismatch (отравление чужим member_id)', async () => {
    const r = await verifyInstallMember('m-victim', 'RT-attacker', oauthReturning(tokens({ memberId: 'm-attacker' })))
    expect(r).toEqual({ ok: false, status: 403, reason: 'member_mismatch' })
  })

  it('refresh отказал 4xx (invalid_grant/401) → 403 (подделанный/отозванный грант)', async () => {
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('invalid_grant', 400)))).toMatchObject({
      ok: false,
      status: 403
    })
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('unauthorized', 401)))).toMatchObject({
      ok: false,
      status: 403
    })
  })

  it('сеть (OAuthError без статуса) / 5xx / не-OAuthError → 503 (fail-closed, не ложно-отвергаем)', async () => {
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('Сеть недоступна')))).toEqual({
      ok: false,
      status: 503,
      reason: 'refresh_unavailable'
    })
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('bad gateway', 502)))).toMatchObject({
      ok: false,
      status: 503
    })
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new Error('boom')))).toMatchObject({ ok: false, status: 503 })
  })

  it('пустой member_id в гранте → 503 (инфра, не удаляем/не принимаем вслепую)', async () => {
    expect(await verifyInstallMember('m-1', 'RT', oauthReturning(tokens({ memberId: '' })))).toEqual({
      ok: false,
      status: 503,
      reason: 'no_member_id'
    })
  })
})
