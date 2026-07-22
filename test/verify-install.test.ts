import { describe, expect, it } from 'vitest'
import {
  verifyInstallMember,
  applyVerifiedTokens,
  decideInstallDoubleDispatch,
  type RefreshCapable
} from '../src/bitrix24/verify-install'
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
    // Underlying-статус подмешан в reason для прод-диагностики (429 ≠ 5xx ≠ сеть на логах).
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('too many requests', 429)))).toEqual({
      ok: false,
      status: 503,
      reason: 'refresh_unavailable_429'
    })
  })

  it('сеть (OAuthError без статуса) / 5xx / не-OAuthError → 503 (fail-closed, не ложно-отвергаем)', async () => {
    // Без HTTP-статуса (сеть/таймаут) — reason без суффикса.
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('Сеть недоступна')))).toEqual({
      ok: false,
      status: 503,
      reason: 'refresh_unavailable'
    })
    // 5xx — статус в reason (отличим «OAuth-сервер лёг» от rate-limit/сети).
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new OAuthError('bad gateway', 502)))).toEqual({
      ok: false,
      status: 503,
      reason: 'refresh_unavailable_502'
    })
    // Не-OAuthError (без статуса) — reason без суффикса.
    expect(await verifyInstallMember('m-1', 'RT', oauthThrowing(new Error('boom')))).toEqual({
      ok: false,
      status: 503,
      reason: 'refresh_unavailable'
    })
  })

  it('пустой member_id в гранте → 503 (инфра, не удаляем/не принимаем вслепую)', async () => {
    expect(await verifyInstallMember('m-1', 'RT', oauthReturning(tokens({ memberId: '' })))).toEqual({
      ok: false,
      status: 503,
      reason: 'no_member_id'
    })
  })

  it('рефрешит ИМЕННО присланный refresh_token (проброс аргумента, не что-то иное)', async () => {
    let seen: string | undefined
    const oauth: RefreshCapable = {
      refresh: (rt) => {
        seen = rt
        return Promise.resolve(tokens())
      }
    }
    await verifyInstallMember('m-1', 'RT-posted', oauth)
    expect(seen).toBe('RT-posted')
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

  it('грант без domain/clientEndpoint: domain из присланного, но clientEndpoint ДЕРИВИТСЯ (не присланный host → SSRF)', () => {
    const t = tokens({ domain: undefined, clientEndpoint: undefined })
    // Присланный clientEndpoint указывает на внутренний хост — он НЕ должен утечь в грант.
    const out = applyVerifiedTokens(installAuth({ domain: 'posted.b24', clientEndpoint: 'https://evil.internal/rest/' }), t, NOW)
    expect(out.domain).toBe('posted.b24')
    expect(out.clientEndpoint).toBe('https://posted.b24/rest/') // деривится из domain, не из присланного endpoint
  })

  it('application_token и прочие install-поля сохраняются (рефреш их не возвращает)', () => {
    const out = applyVerifiedTokens(installAuth({ applicationToken: 'app-tok', userId: 7, scope: 'crm' }), tokens(), NOW)
    expect(out.applicationToken).toBe('app-tok')
    expect(out.userId).toBe(7)
    expect(out.scope).toBe('crm')
  })

  it('memberId берётся из гранта (authoritative-by-construction), не из присланного auth', () => {
    // Провенанс из доверенного источника; verifyInstallMember уже гарантировал равенство.
    const out = applyVerifiedTokens(installAuth({ memberId: 'm-1' }), tokens({ memberId: 'm-1' }), NOW)
    expect(out.memberId).toBe('m-1')
  })

  it('clientEndpoint при грант-domain без грант-endpoint ДЕРИВИТСЯ из authoritative domain (не из присланного)', () => {
    // Грант вернул domain, но не client_endpoint → endpoint строим из authoritative domain, а НЕ доверяем
    // присланному auth.clientEndpoint (иначе владелец портала подсунул бы внутренний URL → SSRF).
    const t = tokens({ domain: 'authoritative.b24', clientEndpoint: undefined })
    const out = applyVerifiedTokens(installAuth({ clientEndpoint: 'https://evil.internal/rest/' }), t, NOW)
    expect(out.clientEndpoint).toBe('https://authoritative.b24/rest/')
  })

  it('60с-пол: истёкший грант (expiresAt в прошлом / рассинхрон часов) не даёт 0/отрицательный expiresIn', () => {
    const t = tokens({ expiresAt: '2026-06-13T09:59:30.000Z' }) // на 30с РАНЬШЕ NOW
    const out = applyVerifiedTokens(installAuth(), t, NOW)
    expect(out.expiresIn).toBe(60)
  })
})

describe('decideInstallDoubleDispatch (идемпотентность двойной доставки install)', () => {
  it('refresh_rejected_* + портал УЖЕ установлен → finish (гонка page+event, FINISH_HTML)', () => {
    expect(decideInstallDoubleDispatch('refresh_rejected_400', true)).toBe('finish')
    expect(decideInstallDoubleDispatch('refresh_rejected_401', true)).toBe('finish')
  })

  it('refresh_rejected_* + портала НЕТ → reject (мисконфиг client_secret / битый токен / зонд — видимая ошибка)', () => {
    expect(decideInstallDoubleDispatch('refresh_rejected_400', false)).toBe('reject')
  })

  it('member_mismatch → всегда reject (реальная подделка; не светим факт установки даже при существующем портале)', () => {
    expect(decideInstallDoubleDispatch('member_mismatch', true)).toBe('reject')
    expect(decideInstallDoubleDispatch('member_mismatch', false)).toBe('reject')
  })

  it('транзиент 503 (refresh_unavailable*) → reject (не двойная доставка, ретраибельно)', () => {
    expect(decideInstallDoubleDispatch('refresh_unavailable', true)).toBe('reject')
    expect(decideInstallDoubleDispatch('refresh_unavailable_429', true)).toBe('reject')
    expect(decideInstallDoubleDispatch('no_member_id', true)).toBe('reject')
  })
})
