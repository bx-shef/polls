import { describe, expect, it } from 'vitest'
import { readPortalGrant } from '../../server/domain/portals/grant'

/** Как выглядит настоящее `auth` события установки — по документации ONAPPINSTALL. */
const REAL = {
  domain: 'shef.bitrix24.ru',
  scope: 'crm im imbot placement bizproc pull',
  access_token: 's6p6eclrvim6da22ft9ch94ekreb52lv',
  refresh_token: '4s386p3q0tr8dy89xvmt96234v3dljg8',
  expires_in: 3600,
  server_endpoint: 'https://oauth.bitrix24.tech/rest/',
  status: 'F',
  client_endpoint: 'https://shef.bitrix24.ru/rest/',
  member_id: 'a223c6b3710f85df22e9377d6c4f7553',
  application_token: '51856fefc120afa4b628cc82d3935cce',
}

/** Копия гранта без одного поля: проверяем, что каждое обязательное действительно обязательно. */
function without(field: keyof typeof REAL): Record<string, unknown> {
  return Object.fromEntries(Object.entries(REAL).filter(([key]) => key !== field))
}

describe('разбор гранта установки', () => {
  it('принимает грант из документации целиком', () => {
    const result = readPortalGrant(REAL)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grant.domain).toBe('shef.bitrix24.ru')
    expect(result.grant.memberId).toBe(REAL.member_id)
    expect(result.grant.scope).toEqual(['crm', 'im', 'imbot', 'placement', 'bizproc', 'pull'])
    expect(result.grant.expiresIn).toBe(3600)
    // Без этих двух строк присвоения можно поменять местами, и тест остаётся зелёным —
    // а перепутанные токены уедут в базу и в портал.
    expect(result.grant.accessToken).toBe(REAL.access_token)
    expect(result.grant.refreshToken).toBe(REAL.refresh_token)
    expect(result.grant.applicationToken).toBe(REAL.application_token)
  })

  it('режет права и по запятой: так их отдаёт сервер авторизации', () => {
    // Зафиксированное наблюдаемое расхождение: событие установки разделяет пробелом,
    // ответ на обмен токена — запятой.
    const result = readPortalGrant({ ...REAL, scope: 'crm,im,imbot' })

    expect(result.ok && result.grant.scope).toEqual(['crm', 'im', 'imbot'])
  })

  it.each<[keyof typeof REAL, string]>([
    ['domain', 'bad-domain'],
    ['member_id', 'missing-member-id'],
    ['access_token', 'missing-access-token'],
    ['refresh_token', 'missing-refresh-token'],
    ['application_token', 'missing-application-token'],
    ['client_endpoint', 'bad-endpoint'],
  ])('без %s отказывает с причиной %s', (field, reason) => {
    expect(readPortalGrant(without(field))).toEqual({ ok: false, reason })
  })

  it('без application_token не проходит — иначе обработчик событий открыт настежь', () => {
    // Отдельным случаем, потому что это не «поле забыли»: без него мы не сможем отличить
    // событие портала от чужого POST и примем любое.
    expect(readPortalGrant({ ...REAL, application_token: '   ' }))
      .toEqual({ ok: false, reason: 'missing-application-token' })
  })

  it('не принимает client_endpoint на чужом хосте', () => {
    // Иначе первый же вызов метода уйдёт вместе с токеном туда, куда указал отправитель.
    expect(readPortalGrant({ ...REAL, client_endpoint: 'https://attacker.tld/rest/' }))
      .toEqual({ ok: false, reason: 'bad-endpoint' })
    expect(readPortalGrant({ ...REAL, client_endpoint: 'https://other.bitrix24.ru/rest/' }))
      .toEqual({ ok: false, reason: 'bad-endpoint' })
  })

  it('не принимает client_endpoint без https', () => {
    expect(readPortalGrant({ ...REAL, client_endpoint: 'http://shef.bitrix24.ru/rest/' }))
      .toEqual({ ok: false, reason: 'bad-endpoint' })
  })

  it('не разбирает server_endpoint вовсе', () => {
    // Адрес сервера авторизации у нас константой; принимать его из запроса значит
    // согласиться отправить туда client_secret.
    const result = readPortalGrant({ ...REAL, server_endpoint: 'https://attacker.tld/rest/' })

    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('attacker.tld')
  })

  it('читает expires_in, пришедший строкой из формы', () => {
    const result = readPortalGrant({ ...REAL, expires_in: '3600' })

    expect(result.ok && result.grant.expiresIn).toBe(3600)
  })

  it('не падает на мусоре вместо объекта', () => {
    expect(readPortalGrant(null)).toEqual({ ok: false, reason: 'not-an-object' })
    expect(readPortalGrant('строка')).toEqual({ ok: false, reason: 'not-an-object' })
  })
})
