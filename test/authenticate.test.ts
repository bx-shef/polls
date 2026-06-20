import { describe, expect, it, vi } from 'vitest'
import { createPortalAuthenticator } from '../src/bitrix24/authenticate'
import { OAuthError, type HttpFetch, type HttpResponse } from '../src/bitrix24/oauth'

const DOMAIN = 'acme.bitrix24.ru'
const AUTH_ID = 'access-token-xyz'

/** Заглушка HttpResponse. */
function resp(status: number, json: unknown, jsonThrows = false): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jsonThrows ? () => Promise.reject(new Error('not json')) : () => Promise.resolve(json)
  }
}

describe('createPortalAuthenticator — боевой PortalAuthenticator (#47/#49)', () => {
  it('живой токен + установленный портал → member_id из install-маппинга', async () => {
    const fetch = vi.fn<HttpFetch>(async () => resp(200, { result: { ID: 5, STATUS: 'F' } }))
    const resolveMemberId = vi.fn(async () => 'abc123member')
    const authenticate = createPortalAuthenticator({ resolveMemberId, fetch })

    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).resolves.toEqual({ memberId: 'abc123member' })

    // authId — в теле POST, не в URL/query (анти-утечка в access-логи)
    expect(fetch).toHaveBeenCalledWith(`https://${DOMAIN}/rest/app.info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: AUTH_ID })
    })
    expect(resolveMemberId).toHaveBeenCalledWith(DOMAIN)
  })

  it('Bitrix вернул error → OAuthError, резолвер member_id не дёргается', async () => {
    const fetch = vi.fn<HttpFetch>(async () => resp(200, { error: 'expired_token', error_description: 'token expired' }))
    const resolveMemberId = vi.fn(async () => 'abc123member')
    const authenticate = createPortalAuthenticator({ resolveMemberId, fetch })

    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).rejects.toBeInstanceOf(OAuthError)
    expect(resolveMemberId).not.toHaveBeenCalled()
  })

  it('HTTP 401 (чужой портал отверг токен) → OAuthError', async () => {
    const authenticate = createPortalAuthenticator({
      resolveMemberId: async () => 'abc123member',
      fetch: async () => resp(401, { error: 'NO_AUTH_FOUND' })
    })
    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).rejects.toBeInstanceOf(OAuthError)
  })

  it('ok-статус, но result отсутствует → OAuthError', async () => {
    const authenticate = createPortalAuthenticator({
      resolveMemberId: async () => 'abc123member',
      fetch: async () => resp(200, { time: {} })
    })
    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).rejects.toBeInstanceOf(OAuthError)
  })

  it('не-JSON ответ (HTML 502 от прокси) → OAuthError', async () => {
    const authenticate = createPortalAuthenticator({
      resolveMemberId: async () => 'abc123member',
      fetch: async () => resp(502, null, true)
    })
    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).rejects.toBeInstanceOf(OAuthError)
  })

  it('сеть недоступна → OAuthError', async () => {
    const authenticate = createPortalAuthenticator({
      resolveMemberId: async () => 'abc123member',
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).rejects.toBeInstanceOf(OAuthError)
  })

  it('токен жив, но портал не установлен (резолвер → undefined) → OAuthError', async () => {
    const authenticate = createPortalAuthenticator({
      resolveMemberId: async () => undefined,
      fetch: async () => resp(200, { result: { ID: 5 } })
    })
    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).rejects.toBeInstanceOf(OAuthError)
  })
})
