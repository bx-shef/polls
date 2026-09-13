import { describe, expect, it, vi } from 'vitest'
import { refreshTokens } from '../../server/b24/oauth'

/**
 * Обмен токена — единственное, что отличает настоящую установку от подделки. Тесты держат
 * три свойства, каждое из которых чинилось по следам соседнего проекта: секреты не уезжают
 * в адрес, «отказано» отличается от «не смогли проверить», и вернувшийся токен — новый.
 */

function answering(body: unknown, init: { ok?: boolean } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    json: async () => body,
  })) as unknown as typeof fetch
}

const CREDENTIALS = { refreshToken: 'старый-токен', clientId: 'app.123', clientSecret: 'секрет' }

const SUCCESS = {
  access_token: 'новый-access',
  refresh_token: 'новый-refresh',
  member_id: 'a223c6b3710f85df22e9377d6c4f7553',
  expires_in: 3600,
  scope: 'crm,im,imbot',
  client_endpoint: 'https://shef.bitrix24.ru/rest/',
}

describe('обмен refresh_token', () => {
  it('возвращает member_id, посчитанный сервером авторизации', async () => {
    const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering(SUCCESS) })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.tokens.memberId).toBe(SUCCESS.member_id)
    expect(outcome.tokens.scope).toEqual(['crm', 'im', 'imbot'])
    // Сами токены — то, ради чего весь обмен; без этих строк их можно было поменять
    // местами, и тесты оставались зелёными.
    expect(outcome.tokens.accessToken).toBe('новый-access')
    expect(outcome.tokens.refreshToken).toBe('новый-refresh')
    // `client_endpoint` — второе доказательство подлинности, по нему сверяется домен.
    expect(outcome.tokens.clientEndpoint).toBe('https://shef.bitrix24.ru/rest/')
  })

  it('отдаёт НОВЫЙ refresh_token: обмен вращает токен, старый уже мёртв', async () => {
    const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering(SUCCESS) })

    expect(outcome.ok && outcome.tokens.refreshToken).toBe('новый-refresh')
  })

  it('не отправляет секреты в адресе — только в теле', async () => {
    // Адрес попадает в access-лог прокси и в историю, тело — никуда. Документация
    // показывает GET со всеми параметрами в query; здесь сознательно иначе.
    const fetchFn = answering(SUCCESS)
    await refreshTokens({ ...CREDENTIALS, fetchFn })

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).not.toContain('секрет')
    expect(String(url)).not.toContain('старый-токен')
    expect((init as { method: string }).method).toBe('POST')
    expect(String((init as { body: string }).body)).toContain('client_secret=')
  })

  it('идёт на фиксированный хост, а не туда, куда указал запрос', async () => {
    const fetchFn = answering(SUCCESS)
    await refreshTokens({ ...CREDENTIALS, fetchFn })

    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toBe('https://oauth.bitrix.info/oauth/token/')
  })

  it.each(['invalid_grant', 'invalid_token', 'expired_token'])(
    'считает %s отказом: грант поддельный или мёртвый',
    async (code) => {
      const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering({ error: code }) })

      expect(outcome).toEqual({ ok: false, kind: 'rejected', code })
    },
  )

  it('не считает invalid_request отказом: это про форму НАШЕГО запроса', async () => {
    // По документации `invalid_request` — «передан некорректно сформированный
    // авторизационный запрос». Наш баг в сборке тела не должен становиться вечным
    // отказом настоящей установке.
    const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering({ error: 'invalid_request' }) })

    expect(outcome).toEqual({ ok: false, kind: 'unavailable', code: 'invalid_request' })
  })

  it('считает ошибку нашей конфигурации не отказом, а невозможностью проверить', async () => {
    // `wrong_client` — это про наши client_id/client_secret. Отказать установке
    // из-за собственной опечатки в окружении значит обвинить клиента в своей ошибке.
    const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering({ error: 'wrong_client' }) })

    expect(outcome).toEqual({ ok: false, kind: 'unavailable', code: 'wrong_client' })
  })

  it('переживает сетевой сбой как «не смогли проверить»', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    expect(await refreshTokens({ ...CREDENTIALS, fetchFn })).toEqual({ ok: false, kind: 'unavailable', code: 'transport' })
  })

  it('не падает на JSON-примитиве вместо объекта', async () => {
    // Кривой прокси отвечает валидным JSON, который не объект; `'error' in "строка"` бросил бы.
    const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering('сервис недоступен') })

    expect(outcome).toEqual({ ok: false, kind: 'unavailable', code: 'malformed_response' })
  })

  it('пустой member_id — это «не смогли проверить», а не «подделка»', async () => {
    // Отказать живой установке дороже, чем попросить повторить.
    const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering({ ...SUCCESS, member_id: '  ' }) })

    expect(outcome).toEqual({ ok: false, kind: 'unavailable', code: 'no_member_id' })
  })

  it.each([0, -60, 'ерунда'])('подставляет час жизни вместо негодного expires_in (%s)', async (value) => {
    // Ноль и отрицательное значение опаснее отсутствующего: с ними токен считается
    // истёкшим сразу, и приложение полезет продлевать его на первом же вызове —
    // за такое частое продление документация обещает блокировку.
    const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering({ ...SUCCESS, expires_in: value }) })

    expect(outcome.ok && outcome.tokens.expiresIn).toBe(3600)
  })

  it('подставляет документированный час жизни, когда сервер его не назвал', async () => {
    const { expires_in: _dropped, ...withoutExpiry } = SUCCESS
    const outcome = await refreshTokens({ ...CREDENTIALS, fetchFn: answering(withoutExpiry) })

    expect(outcome.ok && outcome.tokens.expiresIn).toBe(3600)
  })
})
