import { isPortalDomain } from './zones'

/**
 * The authorization grant a portal hands us when the app is installed.
 *
 * Доменное представление: обычный объект без единого знания о том, как он приехал.
 * Разбор HTTP-тела живёт в `server/b24/`, сюда приходит уже готовая структура.
 */
export interface PortalGrant {
  domain: string
  memberId: string
  accessToken: string
  refreshToken: string
  /** Постоянный токен приложения: по нему сверяются все последующие события портала. */
  applicationToken: string
  /** Секунды жизни `accessToken` — портал присылает именно длительность, а не момент. */
  expiresIn: number
  scope: string[]
  /** Куда уходят вызовы методов портала. Адрес сервера авторизации в гранте не читаем вовсе. */
  clientEndpoint: string
  /** `L` локальное, `F` бесплатное тиражное, `S` подписное тиражное. */
  status: string
}

/**
 * Почему грант отвергнут.
 *
 * Именованные причины, а не булево: они уезжают в лог и в метрику, и «не установилось»
 * без причины — это вызов в поддержку вместо строки в журнале. Текстов клиенту здесь нет
 * намеренно, их место в обработчике.
 */
export type GrantRejection
  = | 'not-an-object'
    | 'bad-domain'
    | 'missing-member-id'
    | 'missing-access-token'
    | 'missing-refresh-token'
    | 'missing-application-token'
    | 'bad-endpoint'

export type GrantResult
  = | { ok: true, grant: PortalGrant }
    | { ok: false, reason: GrantRejection }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * `client_endpoint` приходит из того же непроверенного запроса, что и остальное.
 *
 * Если принять его как есть, первый же вызов метода уйдёт по адресу, который выбрал
 * отправитель запроса, — вместе с токеном портала. Поэтому требуем https и тот же домен,
 * что и в `auth.domain`: это адрес самого портала, а не какой-то другой службы.
 *
 * `server_endpoint` не проверяется, потому что не используется: адрес сервера авторизации
 * задан у нас константой (`server/b24/oauth.ts`), и это единственная надёжная защита
 * от того, чтобы `client_secret` уехал по чужому адресу.
 */
function isPortalEndpoint(value: unknown, domain: string): boolean {
  const raw = text(value)
  if (raw === '') return false
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === domain
  }
  catch {
    return false
  }
}

/**
 * Прочитать объект `auth` события установки в доменный грант.
 *
 * Проверяется состав, а не подлинность: подтвердить, что грант действительно от этого
 * портала, можно только переавторизацией (`server/b24/oauth.ts`). Здесь отсекается то,
 * с чем и пробовать незачем.
 */
export function readPortalGrant(auth: unknown): GrantResult {
  if (typeof auth !== 'object' || auth === null) {
    return { ok: false, reason: 'not-an-object' }
  }

  const raw = auth as Record<string, unknown>
  const domain = text(raw.domain).toLowerCase()
  if (!isPortalDomain(domain)) return { ok: false, reason: 'bad-domain' }

  const memberId = text(raw.member_id)
  if (memberId === '') return { ok: false, reason: 'missing-member-id' }

  const accessToken = text(raw.access_token)
  if (accessToken === '') return { ok: false, reason: 'missing-access-token' }

  const refreshToken = text(raw.refresh_token)
  if (refreshToken === '') return { ok: false, reason: 'missing-refresh-token' }

  // Без него мы не сможем проверить ни одно последующее событие портала, то есть примем
  // любое. Отсутствие `application_token` — это не «поле забыли», это открытый обработчик.
  const applicationToken = text(raw.application_token)
  if (applicationToken === '') return { ok: false, reason: 'missing-application-token' }

  if (!isPortalEndpoint(raw.client_endpoint, domain)) {
    return { ok: false, reason: 'bad-endpoint' }
  }

  return {
    ok: true,
    grant: {
      domain,
      memberId,
      accessToken,
      refreshToken,
      applicationToken,
      // Форма присылает числа строками, JSON — числами. `Number` разбирает оба,
      // а отрицательное или нечисловое значение приравниваем к «истёк сейчас».
      expiresIn: Math.max(0, Number(raw.expires_in) || 0),
      // Портал отдаёт права одной строкой через пробел, документация про `scope` —
      // «список прав, выданных приложению, через пробел». Запятая встречается
      // в ответе сервера авторизации, поэтому режем по обоим разделителям.
      scope: text(raw.scope).split(/[\s,]+/).filter(Boolean),
      clientEndpoint: text(raw.client_endpoint),
      status: text(raw.status),
    },
  }
}
