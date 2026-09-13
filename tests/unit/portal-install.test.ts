import { describe, expect, it, vi } from 'vitest'
import { decideInstall, type ReauthOutcome } from '../../server/domain/portals/install'

/**
 * Решение об установке целиком: именно здесь живёт единственное, что отличает настоящую
 * установку от подделки. До выноса в доменный слой эта ветка лежала в обработчике Nitro
 * и не проверялась ничем — обработчик держится на автоимпорте `defineEventHandler`,
 * которого нет ни в одном окружении `vitest`.
 */

const MEMBER_ID = 'a223c6b3710f85df22e9377d6c4f7553'

/** Тело события установки в том виде, в каком его отдаёт портал. */
function payload(overrides: Record<string, string> = {}) {
  return {
    event: 'ONAPPINSTALL',
    auth: {
      domain: 'shef.bitrix24.ru',
      scope: 'crm im imbot placement bizproc pull',
      access_token: 'старый-access',
      refresh_token: 'присланный-refresh',
      expires_in: '3600',
      server_endpoint: 'https://oauth.bitrix24.tech/rest/',
      status: 'F',
      client_endpoint: 'https://shef.bitrix24.ru/rest/',
      member_id: MEMBER_ID,
      application_token: '51856fefc120afa4b628cc82d3935cce',
      ...overrides,
    },
  }
}

/** Успешная переавторизация: сервер подтверждает тот же портал и вращает токен. */
const CONFIRMED: ReauthOutcome = {
  ok: true,
  tokens: {
    memberId: MEMBER_ID,
    accessToken: 'обменянный-access',
    refreshToken: 'обменянный-refresh',
    expiresIn: 3600,
    scope: ['crm', 'im'],
    clientEndpoint: 'https://shef.bitrix24.ru/rest/',
  },
}

const answering = (outcome: ReauthOutcome) => ({ reauthorize: vi.fn(async () => outcome) })

describe('подтверждённая установка', () => {
  it('записывает портал', async () => {
    const decision = await decideInstall(payload(), answering(CONFIRMED))

    expect(decision.status).toBe(200)
    expect(decision.action?.type).toBe('register')
  })

  it('берёт member_id из переавторизации, а не из события', async () => {
    // Присланный контролирует отправитель; апсерт целится в member_id, и разойдись они —
    // родилась бы вторая строка вместо обновления первой, а с ней потерялись бы привязки.
    const decision = await decideInstall(
      payload({ member_id: MEMBER_ID.toUpperCase() }),
      answering(CONFIRMED),
    )

    expect(decision.action?.memberId).toBe(MEMBER_ID)
  })

  it('сохраняет ОБМЕНЯННЫЕ токены: присланный refresh_token уже мёртв', async () => {
    const decision = await decideInstall(payload(), answering(CONFIRMED))

    expect(decision.action?.accessToken).toBe('обменянный-access')
    expect(decision.action?.refreshToken).toBe('обменянный-refresh')
  })

  it('берёт срок жизни токена из переавторизации', async () => {
    // В событии это поле тоже есть, но оно относится к уже сожжённому токену.
    const shortLived = { ...CONFIRMED, tokens: { ...CONFIRMED.tokens, expiresIn: 1800 } }
    const decision = await decideInstall(payload({ expires_in: '999999' }), answering(shortLived))

    expect(decision.action?.expiresInSeconds).toBe(1800)
  })

  it('записывает домен из ПОДТВЕРЖДЁННОГО адреса, а не из события', async () => {
    // `client_endpoint` посчитал сервер авторизации; `auth.domain` прислал тот же,
    // кто прислал всё остальное. Регистр в событии не должен доезжать до базы.
    const decision = await decideInstall(payload({ domain: 'SHEF.bitrix24.ru' }), answering(CONFIRMED))

    expect(decision.action?.domain).toBe('shef.bitrix24.ru')
  })

  it('сохраняет application_token из события — у сервера авторизации его нет', async () => {
    const decision = await decideInstall(payload(), answering(CONFIRMED))

    expect(decision.action?.applicationToken).toBe('51856fefc120afa4b628cc82d3935cce')
  })

  it('берёт права из переавторизации, а при пустых — из события', async () => {
    const withScope = await decideInstall(payload(), answering(CONFIRMED))
    expect(withScope.action?.scope).toEqual(['crm', 'im'])

    const empty = { ...CONFIRMED, tokens: { ...CONFIRMED.tokens, scope: [] } }
    const fallback = await decideInstall(payload(), answering(empty))
    expect(fallback.action?.scope).toContain('placement')
  })
})

describe('отклонённая установка', () => {
  it('не совпал member_id — 403 и ни одного действия', async () => {
    // Ровно то, ради чего написан весь модуль: чужой портал предъявить нельзя.
    const foreign = { ...CONFIRMED, tokens: { ...CONFIRMED.tokens, memberId: 'чужой-портал' } }
    const decision = await decideInstall(payload(), answering(foreign))

    expect(decision).toEqual({ status: 403, reason: 'member-mismatch' })
  })

  it('не совпал домен с тем, что вернул сервер авторизации — 403', async () => {
    // `client_endpoint` возвращает сервер, и продиктовать его в запросе обмена нечем:
    // в теле только grant_type, client_id, client_secret и refresh_token.
    const decision = await decideInstall(
      payload({ domain: 'victim.bitrix24.ru', client_endpoint: 'https://victim.bitrix24.ru/rest/' }),
      answering(CONFIRMED),
    )

    expect(decision).toEqual({ status: 403, reason: 'domain-mismatch' })
  })

  it('пустой client_endpoint не отвергает установку, но оставляет след', async () => {
    const noProof = { ...CONFIRMED, tokens: { ...CONFIRMED.tokens, clientEndpoint: '' } }
    const decision = await decideInstall(payload(), answering(noProof))

    expect(decision.status).toBe(200)
    expect(decision.reason).toBe('installed-without-endpoint-proof')
  })

  it('отказ гранта — 403, невозможность проверить — 503', async () => {
    const rejected = await decideInstall(payload(), answering({ ok: false, kind: 'rejected', code: 'invalid_grant' }))
    expect(rejected).toEqual({ status: 403, reason: 'invalid_grant' })

    const unavailable = await decideInstall(payload(), answering({ ok: false, kind: 'unavailable', code: 'transport' }))
    expect(unavailable).toEqual({ status: 503, reason: 'transport' })
  })

  it('не разбирает регистр кода события', async () => {
    // Портал пишет `OnAppInstall`, документация — `ONAPPINSTALL`.
    const decision = await decideInstall({ ...payload(), event: 'OnAppInstall' }, answering(CONFIRMED))

    expect(decision.status).toBe(200)
  })

  it('чужое событие — 400 и без единого исходящего запроса', async () => {
    const deps = answering(CONFIRMED)
    const decision = await decideInstall({ ...payload(), event: 'ONAPPUNINSTALL' }, deps)

    expect(decision).toEqual({ status: 400, reason: 'unexpected-event' })
    expect(deps.reauthorize).not.toHaveBeenCalled()
  })

  it('негодный грант — 400 и без единого исходящего запроса', async () => {
    // Порядок проверок не косметика: поток мусорных POST не должен превращаться
    // в поток наших обращений к серверу авторизации, за который блокируют приложение.
    const deps = answering(CONFIRMED)
    const decision = await decideInstall(payload({ domain: 'attacker.tld' }), deps)

    expect(decision).toEqual({ status: 400, reason: 'bad-domain' })
    expect(deps.reauthorize).not.toHaveBeenCalled()
  })

  it('меняет на переавторизацию присланный refresh_token, а не access_token', async () => {
    const deps = answering(CONFIRMED)
    await decideInstall(payload(), deps)

    expect(deps.reauthorize).toHaveBeenCalledWith('присланный-refresh')
  })
})
