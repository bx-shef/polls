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

    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).resolves.toEqual({
      memberId: 'abc123member',
      admin: false
    })

    // authId — в теле POST, не в URL/query (анти-утечка в access-логи)
    expect(fetch).toHaveBeenCalledWith(`https://${DOMAIN}/rest/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: AUTH_ID })
    })
    expect(resolveMemberId).toHaveBeenCalledWith(DOMAIN)
  })

  it('profile.ADMIN=true → роль администратора попадает в результат (на ней гейт записи)', async () => {
    const fetch = vi.fn<HttpFetch>(async () => resp(200, { result: { ID: 5, ADMIN: true } }))
    const authenticate = createPortalAuthenticator({ resolveMemberId: async () => 'abc123member', fetch })
    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).resolves.toMatchObject({ admin: true })
  })

  it('ADMIN в неожиданной форме → НЕ администратор (fail-closed, права не выдаём по догадке)', async () => {
    // Bitrix отдаёт булево; строка «Y»/1/«true» — чужой или изменившийся формат. Права записи по
    // такому значению выдавать нельзя: тихая смена формата на стороне портала стала бы эскалацией.
    for (const ADMIN of ['Y', 1, 'true', {}, null, undefined]) {
      const fetch = vi.fn<HttpFetch>(async () => resp(200, { result: { ID: 5, ADMIN } }))
      const authenticate = createPortalAuthenticator({ resolveMemberId: async () => 'm', fetch })
      await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).resolves.toMatchObject({ admin: false })
    }
  })

  it('форма result сама по себе непригодна (число/строка/массив) → не администратор, не падаем', async () => {
    for (const result of [5, 'ok', []]) {
      const fetch = vi.fn<HttpFetch>(async () => resp(200, { result }))
      const authenticate = createPortalAuthenticator({ resolveMemberId: async () => 'm', fetch })
      await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).resolves.toMatchObject({ admin: false })
    }
  })

  it('result === null → OAuthError (портал не подтвердил токен)', async () => {
    const fetch = vi.fn<HttpFetch>(async () => resp(200, { result: null }))
    const resolveMemberId = vi.fn(async () => 'm')
    const authenticate = createPortalAuthenticator({ resolveMemberId, fetch })
    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).rejects.toBeInstanceOf(OAuthError)
    expect(resolveMemberId).not.toHaveBeenCalled()
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

  it('ok-статус (200), но тело не-JSON (json() бросил) → OAuthError', async () => {
    const resolveMemberId = vi.fn(async () => 'abc123member')
    const authenticate = createPortalAuthenticator({ resolveMemberId, fetch: async () => resp(200, null, true) })
    await expect(authenticate({ domain: DOMAIN, authId: AUTH_ID })).rejects.toBeInstanceOf(OAuthError)
    expect(resolveMemberId).not.toHaveBeenCalled()
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
