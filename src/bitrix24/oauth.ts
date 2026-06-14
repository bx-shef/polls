import { z } from 'zod'

/**
 * OAuth-клиент Bitrix24 (ISSUE #3): обмен кода на токены при установке и refresh
 * протухшего access-token. HTTP инжектируется (`fetch`-совместимый) — логика
 * проверяется юнит-тестами без живого портала; прод передаёт global fetch.
 * Endpoint и формат — по докам Bitrix24 oauth (https://oauth.bitrix.info/oauth/token/).
 *
 * Ретраи/таймауты/circuit-breaker — НЕ ответственность ядра: `request()` бросает
 * `OAuthError` без повтора; устойчивость к сбоям сети добавляет HTTP-слой деплоя.
 */

/** Верхняя граница `expires_in` (сек): 1 год. Защита от переполнения Date. */
const MAX_EXPIRES_IN = 366 * 24 * 3600

/** Нормализованные токены (то, что шифруется и хранится). */
export const oauthTokensSchema = z.object({
  memberId: z.string().min(1).max(200),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** ISO-8601; вычислен из expires_in на момент выдачи. */
  expiresAt: z.string().datetime({ offset: true }),
  domain: z.string().max(200).optional(),
  // SSRF: при использовании как URL исходящих REST-вызовов (фаза связки) хост
  // обязательно валидировать по allowlist (*.bitrix24.ru/.com/...), не localhost/RFC-1918.
  clientEndpoint: z.string().max(500).optional()
})
export type OAuthTokens = z.infer<typeof oauthTokensSchema>

/** Сырой успешный ответ token-эндпоинта Bitrix24 (лишние поля отбрасываются). */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  // .max(): аномально большой expires_in иначе переполнит Date → RangeError.
  expires_in: z.number().int().positive().max(MAX_EXPIRES_IN),
  member_id: z.string().min(1),
  domain: z.string().optional(),
  client_endpoint: z.string().optional()
})

export interface HttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
/** Подмножество RequestInit, нужное клиенту (POST token-эндпоинта). */
export interface HttpRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}
/** Минимум, совместимый с global fetch (POST token-эндпоинта). */
export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>

/** Ошибка OAuth без утечки секретов в сообщение. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

export interface Bitrix24OAuthOptions {
  clientId: string
  clientSecret: string
  fetch?: HttpFetch
  /** Переопределяется в тестах; по умолчанию официальный oauth-сервер. */
  tokenUrl?: string
  now?: () => Date
}

export class Bitrix24OAuth {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly fetch: HttpFetch
  private readonly tokenUrl: string
  private readonly now: () => Date

  constructor(opts: Bitrix24OAuthOptions) {
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init) as Promise<HttpResponse>)
    this.tokenUrl = opts.tokenUrl ?? 'https://oauth.bitrix.info/oauth/token/'
    this.now = opts.now ?? ((): Date => new Date())
  }

  /** Установка приложения: обмен authorization code на токены. */
  exchangeCode(code: string): Promise<OAuthTokens> {
    return this.request({ grant_type: 'authorization_code', code })
  }

  /** Обновление протухшего access-token по refresh-token. */
  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.request({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  private async request(params: Record<string, string>): Promise<OAuthTokens> {
    // client_secret — в теле POST (RFC 6749 §2.3.1), НЕ в URL: иначе секрет течёт
    // в access-логи прокси/CDN/APM и Referer.
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...params
    }).toString()
    let res: HttpResponse
    try {
      res = await this.fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body
      })
    } catch {
      throw new OAuthError('Сеть недоступна при обращении к OAuth Bitrix24')
    }
    // Тело читаем мягко: на ошибочном статусе non-JSON ответ (HTML 502 от прокси)
    // не должен маскировать реальный отказ под «некорректный ответ».
    let body2: unknown
    let jsonOk = true
    try {
      body2 = await res.json()
    } catch {
      jsonOk = false
    }
    if (!res.ok) {
      // error_description от Bitrix безопасно показать; токенов в ошибке нет
      const desc = jsonOk ? (body2 as { error_description?: string; error?: string })?.error_description : undefined
      throw new OAuthError(`OAuth Bitrix24 отказал: ${desc ?? `HTTP ${res.status}`}`, res.status)
    }
    if (!jsonOk) throw new OAuthError('Некорректный ответ OAuth Bitrix24', res.status)
    const parsed = tokenResponseSchema.safeParse(body2)
    if (!parsed.success) throw new OAuthError('OAuth Bitrix24 вернул неполные токены', res.status)
    const r = parsed.data
    return {
      memberId: r.member_id,
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: new Date(this.now().getTime() + r.expires_in * 1000).toISOString(),
      domain: r.domain,
      clientEndpoint: r.client_endpoint
    }
  }
}
