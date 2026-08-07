import { OAuthError, type HttpFetch, type HttpResponse } from './oauth'
import type { PortalAuthenticator } from './frame'

/**
 * Боевой `PortalAuthenticator` для handshake app-фрейма (ISSUE #47/#49) — то, что
 * `frame.ts:verifyFrameAuth` инжектирует как авторитетный источник `member_id` и роли вызывающего.
 *
 * Зачем именно так (а не «доверять member_id из POST»):
 *  1. ЛЁГКИЙ REST-вызов `profile` к `https://{domain}/rest/profile` с переданным `authId`
 *     авторитетно доказывает, что токен ЖИВ и принадлежит ИМЕННО этому порталу: токен другого
 *     портала REST-эндпоинт `{domain}` отвергнет (`NO_AUTH_FOUND`/`expired_token`). НЕ через
 *     OAuth-refresh (ротирует токен → race при параллельных загрузках фрейма).
 *  2. `member_id` REST-методами не возвращается — берём его из install-time маппинга
 *     `domain → member_id` (таблица `portal`, `PortalTokenStore.save`) через инжектируемый
 *     `resolveMemberId`. `verifyFrameAuth` затем СВЕРЯЕТ его с заявленным в POST (анти-cross-tenant).
 *  3. `profile` вместо прежнего `app.info` — та же цена (один вызов, скоуп не нужен), но он ещё и
 *     отдаёт `ADMIN`: роль пользователя, чьим токеном открыт фрейм. Без неё сессия знала только
 *     «какой это портал», и ЛЮБОЙ сотрудник портала мог опубликовать опрос — то есть изменить текст,
 *     который увидит клиент заказчика.
 *
 * `domain` уже прошёл SSRF-allowlist в `verifyFrameAuth` ДО вызова — здесь это доверенный хост.
 * HTTP/резолвер инжектируются → логика проверяется юнит-тестами без живого портала.
 */

/**
 * Минимум ответа `profile` для нас: успех (`result` с флагом `ADMIN`) либо ошибка (`error`).
 * `ADMIN` сверяем строго с `true`: Bitrix отдаёт булево, но чужой/изменившийся формат (строка «Y»,
 * число) не должен случайно дать права записи — неизвестная форма трактуется как «не администратор».
 */
interface ProfileResponse {
  result?: { ADMIN?: unknown } | null
  error?: string
  error_description?: string
}

export interface CreateAuthenticatorOptions {
  /** Резолвер install-time маппинга `domain → member_id` (прод: `select member_id from portal where domain=$1`). */
  resolveMemberId: (domain: string) => Promise<string | undefined>
  /** HTTP (по умолчанию global fetch); переопределяется в тестах. */
  fetch?: HttpFetch
}

export function createPortalAuthenticator(opts: CreateAuthenticatorOptions): PortalAuthenticator {
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init) as Promise<HttpResponse>)

  return async ({ domain, authId }) => {
    // `authId` — в ТЕЛЕ POST, не в query: иначе токен утечёт в access-логи прокси/CDN.
    let res: HttpResponse
    try {
      res = await doFetch(`https://${domain}/rest/profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auth: authId })
      })
    } catch {
      throw new OAuthError('Сеть недоступна при проверке токена фрейма Bitrix24')
    }

    let body: ProfileResponse | undefined
    try {
      body = (await res.json()) as ProfileResponse
    } catch {
      // не-JSON (HTML 502 от прокси) на не-ok статусе → отказ; на ok статусе — некорректный ответ
      body = undefined
    }

    if (!res.ok || !body || body.error || body.result == null) {
      // Содержимое токена в сообщение не включаем; описание ошибки от Bitrix безопасно.
      throw new OAuthError(`Bitrix24 отклонил токен фрейма: ${body?.error_description ?? body?.error ?? `HTTP ${res.status}`}`)
    }

    const memberId = await opts.resolveMemberId(domain)
    if (!memberId) {
      // Токен жив, но портал у нас не установлен (нет OAuth-маппинга) → сессию не выписываем.
      throw new OAuthError('Портал фрейма не установлен (нет сохранённого member_id)')
    }
    // Роль ИМЕННО ТОГО пользователя, чьим токеном открыт фрейм: на ней стоит гейт записи.
    return { memberId, admin: body.result?.ADMIN === true }
  }
}
