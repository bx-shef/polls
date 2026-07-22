import { describe, expect, it } from 'vitest'
import { verifyInstallMember, applyVerifiedTokens, type RefreshCapable } from '../src/bitrix24/verify-install'
import { OAuthError, type OAuthTokens } from '../src/bitrix24/oauth'
import type { InstallAuth } from '../src/bitrix24/install'

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

  it('refresh отказал ТОЛЬКО 400 invalid_grant / 401 → 403 (подделанный/отозванный грант)', async () => {
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('invalid_grant', 400)))).toEqual({
      ok: false,
      status: 403,
      reason: 'refresh_rejected_400'
    })
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('unauthorized', 401)))).toEqual({
      ok: false,
      status: 403,
      reason: 'refresh_rejected_401'
    })
  })

  it('429 rate-limit → 503 (транзиент, НЕ 403 — не ложно-отвергаем легитимную установку под нагрузкой)', async () => {
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('too many requests', 429)))).toEqual({
      ok: false,
      status: 503,
      reason: 'refresh_unavailable'
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

const installAuth = (over: Partial<InstallAuth> = {}): InstallAuth => ({
  accessToken: 'AT-posted',
  refreshToken: 'RT-posted',
  expiresIn: 3600,
  memberId: 'm-1',
  domain: 'posted.b24',
  applicationToken: 'app-tok',
  ...over
})

describe('applyVerifiedTokens (сборка InstallAuth из ротированного гранта)', () => {
  const NOW = new Date('2026-06-13T10:00:00.000Z')

  it('подставляет свежие access/refresh, пересчитывает expiresIn из expiresAt гранта', () => {
    // expiresAt на 1ч вперёд от NOW → expiresIn ≈ 3600.
    const t = tokens({ expiresAt: '2026-06-13T11:00:00.000Z', accessToken: 'AT-rot', refreshToken: 'RT-rot' })
    const out = applyVerifiedTokens(installAuth(), t, NOW)
    expect(out.accessToken).toBe('AT-rot')
    expect(out.refreshToken).toBe('RT-rot')
    expect(out.expiresIn).toBe(3600)
  })

  it('event-формат: stale абсолютный expires СБРАШИВАЕТСЯ (иначе installToB24Params взял бы стухший)', () => {
    const t = tokens({ expiresAt: '2026-06-13T11:00:00.000Z' })
    // Присланный event-auth несёт дорефрешевый абсолютный expires.
    const out = applyVerifiedTokens(installAuth({ expires: 1_700_000_000 }), t, NOW)
    expect(out.expires).toBeUndefined()
  })

  it('authoritative domain/clientEndpoint из гранта перекрывают присланные (частичное закрытие domain-poisoning)', () => {
    const t = tokens({ domain: 'authoritative.b24', clientEndpoint: 'https://authoritative.b24/rest/' })
    const out = applyVerifiedTokens(installAuth({ domain: 'posted.b24' }), t, NOW)
    expect(out.domain).toBe('authoritative.b24')
    expect(out.clientEndpoint).toBe('https://authoritative.b24/rest/')
  })

  it('грант без domain/clientEndpoint → фолбэк на присланные install-auth', () => {
    const t = tokens({ domain: undefined, clientEndpoint: undefined })
    const out = applyVerifiedTokens(installAuth({ domain: 'posted.b24', clientEndpoint: 'https://posted.b24/rest/' }), t, NOW)
    expect(out.domain).toBe('posted.b24')
    expect(out.clientEndpoint).toBe('https://posted.b24/rest/')
  })

  it('application_token и прочие install-поля сохраняются (рефреш их не возвращает)', () => {
    const out = applyVerifiedTokens(installAuth({ applicationToken: 'app-tok', userId: 7, scope: 'crm' }), tokens(), NOW)
    expect(out.applicationToken).toBe('app-tok')
    expect(out.userId).toBe(7)
    expect(out.scope).toBe('crm')
  })

  it('60с-пол: истёкший грант (expiresAt в прошлом / рассинхрон часов) не даёт 0/отрицательный expiresIn', () => {
    const t = tokens({ expiresAt: '2026-06-13T09:59:30.000Z' }) // на 30с РАНЬШЕ NOW
    const out = applyVerifiedTokens(installAuth(), t, NOW)
    expect(out.expiresIn).toBe(60)
  })
})
