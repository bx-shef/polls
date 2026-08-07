/**
 * Заголовки безопасности HTTP-ответа.
 *
 * **Почему это в приложении, а не в nginx.** У соседнего проекта такие заголовки живут в конфиге
 * nginx, а в приложении включаются флагом — как замена прокси там, где его нет. У нас иначе: своего
 * nginx-конфига с этими заголовками **нет вообще** (прод стоит за общим `nginx-proxy`, который
 * маршрутизирует и выпускает TLS, но политику безопасности не задаёт). То есть здесь — единственное
 * место, где они появляются, и поэтому они включены ВСЕГДА, без флага.
 *
 * Самое важное для нас — `frame-ancestors`. Приложение работает внутри iframe портала Bitrix24, и без
 * этой директивы страницу может встроить в свой iframe **любой сайт**: поверх кнопок можно положить
 * прозрачный слой и заставить сотрудника нажать не то, что он видит (кликджекинг). Публичная страница
 * прохождения опроса уязвима так же — чужой сайт мог бы выдать её за свою форму.
 *
 * Чистая функция от «что за запрос» → набор заголовков: без h3, без env-чтения внутри, поэтому
 * проверяется юнит-тестами.
 */

/** Зоны облачных порталов Bitrix24, которым разрешено встраивать нас в iframe. */
export const B24_FRAME_ZONES = [
  'bitrix24.ru',
  'bitrix24.com',
  'bitrix24.by',
  'bitrix24.kz',
  'bitrix24.eu',
  'bitrix24.de',
  'bitrix24.ua',
  'bitrix24.pl',
  'bitrix24.fr',
  'bitrix24.it',
  'bitrix24.es',
  'bitrix24.com.br',
  'bitrix24.in',
  'bitrix24.com.tr'
] as const

/**
 * Источники для `frame-ancestors`. `self` — наши же страницы; далее облачные зоны Bitrix24.
 * Self-hosted и box-порталы живут на своём домене — их добавляет `extra` (из настроек).
 *
 * ⚠️ `frame-ancestors` не поддерживает шаблоны вида «любая зона», поэтому список ЯВНЫЙ. Портал в
 * зоне, которой здесь нет, не сможет открыть приложение во фрейме — это лечится настройкой, а не
 * ослаблением директивы до `*`.
 */
export function frameAncestors(extra: readonly string[] = []): string {
  const zones = B24_FRAME_ZONES.map((z) => `https://*.${z}`)
  return ["'self'", ...zones, ...extra].join(' ')
}

/**
 * Разобрать список дополнительных источников из настроек: через запятую или пробел.
 * Пустые и явно непригодные значения отбрасываем — мусор в CSP ломает ВСЮ директиву целиком,
 * поэтому лучше проигнорировать элемент, чем уронить политику.
 */
export function parseExtraFrameAncestors(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 253 && !s.includes(';') && /^https:\/\/[a-z0-9*.-]+$/i.test(s))
}

export interface SecurityHeaderOptions {
  /** Дополнительные источники `frame-ancestors` (self-hosted/box-порталы). */
  extraFrameAncestors?: readonly string[]
  /** Запрос пришёл по HTTPS: только тогда имеет смысл HSTS. */
  https?: boolean
}

/**
 * Политика содержимого. Разрешаем только своё:
 *  - `script-src 'unsafe-inline'` обязателен — Nuxt отдаёт состояние гидратации инлайн-скриптом.
 *    Внешних скриптов у нас нет: SDK Bitrix24 собран в бандл, с порталом он говорит через
 *    postMessage (CSP это не ограничивает);
 *  - `style-src 'unsafe-inline'` — инлайновые стили компонентов b24ui;
 *  - `connect-src` — свой домен плюс порталы Bitrix24 (на случай прямых вызовов из фрейма);
 *  - `object-src 'none'` и `base-uri 'self'` — отключают плагины и подмену базового адреса;
 *  - `form-action 'self'` — форму нельзя отправить на чужой домен.
 */
export function contentSecurityPolicy(extraFrameAncestors: readonly string[] = []): string {
  const b24 = B24_FRAME_ZONES.map((z) => `https://*.${z}`).join(' ')
  return [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `connect-src 'self' ${b24}`,
    `frame-ancestors ${frameAncestors(extraFrameAncestors)}`,
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; ')
}

/**
 * Набор заголовков для ответа. Возвращаем картой, а не выставляем сами, — чтобы решение оставалось
 * чистым, а h3-слой был тонким.
 */
export function securityHeaders(opts: SecurityHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(opts.extraFrameAncestors ?? []),
    // Браузер не должен угадывать тип содержимого: иначе загруженный текст можно подать как скрипт.
    'X-Content-Type-Options': 'nosniff',
    // Чужому сайту уходит только origin, а полный адрес (в нём бывает токен приглашения) — нет.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Доступ к камере/микрофону/геолокации нам не нужен ни на одной странице.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
  }
  // HSTS ставим только на HTTPS: на HTTP он бессмыслен, а в локальной разработке ещё и мешает
  // (браузер запомнит домен и перестанет пускать по http).
  if (opts.https) headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains'
  return headers
}
