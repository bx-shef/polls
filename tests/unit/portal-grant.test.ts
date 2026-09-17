import { describe, expect, it } from 'vitest'
import { readFrameGrant, readPortalGrant } from '../../server/domain/portals/grant'

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
    // Без этих строк присвоения можно поменять местами, и тест остаётся зелёным —
    // а перепутанные токены уедут в базу и в портал.
    expect(result.grant.refreshToken).toBe(REAL.refresh_token)
    expect(result.grant.applicationToken).toBe(REAL.application_token)
  })

  it('не разбирает поля, которые приезжают подтверждёнными с обмена токена', () => {
    // `access_token`, `expires_in`, `client_endpoint` и `status` из события не читаются:
    // первые три приходят подтверждёнными в ответе сервера авторизации, `status` ни на что
    // не влияет. Разобранное и никем не используемое поле — лишний повод отказать установке.
    const result = readPortalGrant(REAL)

    expect(result.ok && Object.keys(result.grant).sort())
      .toEqual(['applicationToken', 'domain', 'memberId', 'refreshToken', 'scope'])
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
    ['refresh_token', 'missing-refresh-token'],
    ['application_token', 'missing-application-token'],
  ])('без %s отказывает с причиной %s', (field, reason) => {
    expect(readPortalGrant(without(field))).toEqual({ ok: false, reason })
  })

  it('без application_token не проходит — иначе обработчик событий открыт настежь', () => {
    // Отдельным случаем, потому что это не «поле забыли»: без него мы не сможем отличить
    // событие портала от чужого POST и примем любое.
    expect(readPortalGrant({ ...REAL, application_token: '   ' }))
      .toEqual({ ok: false, reason: 'missing-application-token' })
  })

  it('не разбирает адреса из события вовсе', () => {
    // Адрес сервера авторизации у нас константой, адрес портала берётся из ответа
    // на обмен токена. Принимать их из запроса значит согласиться сходить туда,
    // куда указал отправитель, — с секретом приложения или с токеном портала.
    const result = readPortalGrant({
      ...REAL,
      server_endpoint: 'https://attacker.tld/rest/',
      client_endpoint: 'https://attacker.tld/rest/',
    })

    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('attacker.tld')
  })

  it('не падает на мусоре вместо объекта', () => {
    expect(readPortalGrant(null)).toEqual({ ok: false, reason: 'not-an-object' })
    expect(readPortalGrant('строка')).toEqual({ ok: false, reason: 'not-an-object' })
  })
})

/**
 * Грант из мастера установки. Ослаблено ровно одно требование — `application_token`,
 * которого фрейм не отдаёт вовсе.
 *
 * ⚠ Блок появился по следам мутационного прогона панели ревью PR #27: замена
 * `readPortalGrant(auth, true)` на `(auth, false)` — один булев литерал, отключающий
 * мастер установки целиком, — пережила все 412 юнит-тестов. Ни typecheck, ни один
 * тестовый файл её не заметили.
 */
describe('грант из мастера установки', () => {
  const { application_token: _dropped, ...WITHOUT_TOKEN } = REAL

  it('принимает грант без токена приложения', () => {
    // Фрейм отдаёт `access_token`, `refresh_token`, `member_id` и `domain` — и всё.
    // Требовать поле, которого источник не присылает, значит сделать мастер неработающим.
    const parsed = readFrameGrant(WITHOUT_TOKEN)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.grant.applicationToken).toBe('')
    expect(parsed.grant.memberId).toBe(REAL.member_id)
    expect(parsed.grant.refreshToken).toBe(REAL.refresh_token)
  })

  it('на том же гранте путь события по-прежнему отказывает', () => {
    // Ослабление касается ТОЛЬКО мастера. Если оно протечёт в путь события, обработчик
    // событий портала останется без единственного способа отличить Битрикс24 от постороннего.
    expect(readPortalGrant(WITHOUT_TOKEN)).toEqual({ ok: false, reason: 'missing-application-token' })
  })

  it('остальные поля обязательны так же строго', () => {
    // Ослабили одно требование — легко ослабить соседнее и не заметить.
    expect(readFrameGrant({ ...WITHOUT_TOKEN, member_id: '' }).ok).toBe(false)
    expect(readFrameGrant({ ...WITHOUT_TOKEN, refresh_token: '' }).ok).toBe(false)
    expect(readFrameGrant({ ...WITHOUT_TOKEN, domain: 'зло.example.com' }).ok).toBe(false)
    expect(readFrameGrant(null).ok).toBe(false)
  })

  it('не даёт мастеру задать токен приложения самому', () => {
    // Контракт «мастер не приносит `application_token`» не должен держаться на том,
    // что страница не пришлёт лишнего поля: тело запроса пишет клиент.
    const parsed = readFrameGrant({ ...REAL, application_token: 'подсунутый' })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.grant.applicationToken).toBe('')
  })
})
