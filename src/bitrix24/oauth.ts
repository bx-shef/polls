import { z } from 'zod'

/**
 * OAuth-клиент Bitrix24 (ISSUE #3): обмен кода на токены при установке и refresh
 * протухшего access-token. HTTP инжектируется (`fetch`-совместимый) — логика
 * проверяется юнит-тестами без живого портала; прод передаёт global fetch.
 * Endpoint и формат — по докам Bitrix24 oauth (https://oauth.bitrix.info/oauth/token/).
 */

/** Нормализованные токены (то, что шифруется и хранится). */
export const oauthTokensSchema = z.object({
  memberId: z.string().min(1).max(200),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** ISO-8601; вычислен из expires_in на момент выдачи. */
  expiresAt: z.string().datetime({ offset: true }),
  domain: z.string().max(200).optional(),
  clientEndpoint: z.string().max(500).optional()
})
export type OAuthTokens = z.infer<typeof oauthTokensSchema>

/** Сырой успешный ответ token-эндпоинта Bitrix24 (лишние поля отбрасываются). */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  member_id: z.string().min(1),
  domain: z.string().optional(),
  client_endpoint: z.string().optional()
})

export interface HttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
/** Минимум, совместимый с global fetch (GET token-эндпоинта). */
export type HttpFetch = (url: string) => Promise<HttpResponse>

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
  private readonly fetch: HttpFetch
  private readonly tokenUrl: string
  private readonly now: () => Date

  constructor(private readonly opts: Bitrix24OAuthOptions) {
    this.fetch = opts.fetch ?? ((url) => fetch(url) as Promise<HttpResponse>)
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
    const qs = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      ...params
    })
    let res: HttpResponse
    try {
      res = await this.fetch(`${this.tokenUrl}?${qs.toString()}`)
    } catch {
      throw new OAuthError('Сеть недоступна при обращении к OAuth Bitrix24')
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new OAuthError('Некорректный ответ OAuth Bitrix24', res.status)
    }
    if (!res.ok) {
      // error_description от Bitrix безопасно показать; токенов в ошибке нет
      const desc = (body as { error_description?: string; error?: string })?.error_description
      throw new OAuthError(`OAuth Bitrix24 отказал: ${desc ?? 'ошибка'}`, res.status)
    }
    const parsed = tokenResponseSchema.safeParse(body)
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
