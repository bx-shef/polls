import { isAllowedPortalDomain } from './frame'
import { type HttpFetch, type HttpResponse } from './oauth'

/**
 * Клиент REST API Bitrix24 (ISSUE #17/#18/#47) — общая основа ВСЕХ исходящих вызовов к порталу
 * (`crm.deal.get`, обогащение имён `crm.company.get`/`user.get`, `event.bind`, `app.info`).
 * Framework-agnostic, HTTP инжектируется → под юнит-тестами без живого портала.
 *
 * Безопасность:
 *  - SSRF: хост портала валидируется по allowlist (`isAllowedPortalDomain`) ПЕРЕД вызовом —
 *    `domain` приходит из недоверенных источников (POST события/фрейма).
 *  - `access_token` уходит в ТЕЛЕ POST, не в query — не утечёт в access-логи прокси/CDN.
 *  - имя метода ограничено `[a-z0-9._]` — нет инъекции пути (`../`, слеши) в URL.
 */

/** Ошибка REST-вызова Bitrix24 без утечки токена в сообщение. */
export class Bitrix24RestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'Bitrix24RestError'
  }
}

/** Контекст вызова: куда (домен портала) и чем (access-token). */
export interface RestContext {
  domain: string
  accessToken: string
}

/** Допустимое имя REST-метода (анти-инъекция пути). */
const METHOD_RE = /^[a-z][a-z0-9._]*$/

export interface Bitrix24RestOptions {
  fetch?: HttpFetch
  /** allowlist доменов портала (self-hosted переопределяет). */
  allowedDomain?: RegExp
}

export class Bitrix24Rest {
  private readonly fetch: HttpFetch
  private readonly allowedDomain?: RegExp

  constructor(opts: Bitrix24RestOptions = {}) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init) as Promise<HttpResponse>)
    this.allowedDomain = opts.allowedDomain
  }

  /**
   * Вызвать REST-метод портала → `result` или `Bitrix24RestError`. `params` сериализуются в тело
   * вместе с `auth` (access-token). Конверт Bitrix: `{ result }` при успехе, `{ error, error_description }`
   * при ошибке (может прийти и на HTTP 200, и на 4xx — разбираем тело мягко).
   */
  async call<T = unknown>(method: string, params: Record<string, unknown>, ctx: RestContext): Promise<T> {
    if (!METHOD_RE.test(method)) throw new Bitrix24RestError(`Недопустимое имя метода: ${method}`)
    if (!isAllowedPortalDomain(ctx.domain, this.allowedDomain)) {
      // Сырой домен в сообщение не включаем (недоверенный ввод → log-injection).
      throw new Bitrix24RestError('Недоверенный домен портала')
    }

    let res: HttpResponse
    try {
      res = await this.fetch(`https://${ctx.domain}/rest/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...params, auth: ctx.accessToken })
      })
    } catch {
      throw new Bitrix24RestError(`Сеть недоступна при вызове ${method}`)
    }

    let body: { result?: unknown; error?: string; error_description?: string } | undefined
    try {
      body = (await res.json()) as typeof body
    } catch {
      body = undefined
    }

    if (body?.error) {
      throw new Bitrix24RestError(`Bitrix24 ${method}: ${body.error_description ?? body.error}`, body.error, res.status)
    }
    if (!res.ok || !body || body.result === undefined) {
      throw new Bitrix24RestError(`Bitrix24 ${method}: некорректный ответ (HTTP ${res.status})`, undefined, res.status)
    }
    return body.result as T
  }
}

/** `crm.deal.get` → поля сделки (для `dealToCrmContext`, #17). */
export function dealGet(rest: Bitrix24Rest, ctx: RestContext, dealId: number): Promise<Record<string, unknown>> {
  return rest.call<Record<string, unknown>>('crm.deal.get', { id: dealId }, ctx)
}
