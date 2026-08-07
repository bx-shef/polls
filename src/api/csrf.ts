/**
 * Защита запросов на ЗАПИСЬ от подделки с чужого сайта (CSRF).
 *
 * Почему это нужно именно нам. Cookie сессии портала выставлена `SameSite=None` — иначе браузер не
 * пошлёт её из iframe Bitrix24, и приложение во фрейме просто не заработает. Но `SameSite=None`
 * означает, что cookie уходит и на запрос, инициированный ЧУЖОЙ страницей. А `readBody` в h3 разбирает
 * JSON и при `content-type: multipart/form-data` — то есть кросс-сайтовый POST можно составить так,
 * что он не требует preflight и всё равно доедет с валидной cookie. Пока cookie несла только «какой
 * это портал», цена была ниже; теперь она несёт ПРИВИЛЕГИЮ (роль администратора), и обещание
 * «публиковать может только админ» держится в том числе на этой проверке.
 *
 * Политика — отказ по ДОКАЗАТЕЛЬСТВУ чужого происхождения, а не по его отсутствию:
 *  - `Sec-Fetch-Site` есть и это не `same-origin` → отказ (современные браузеры шлют заголовок всегда,
 *    и подделать его со страницы нельзя — он запрещён к записи из JS);
 *  - заголовка нет, но есть `Origin` и он не совпадает с адресом приложения → отказ;
 *  - нет ни того ни другого → пропускаем.
 *
 * Последняя ветка — осознанный компромисс. Строгий отказ ломал бы клиентов, которые не шлют ни один
 * из заголовков (старые браузеры, серверные вызовы), ради сценария, которого у современного атакующего
 * всё равно нет: браузер, способный провести CSRF, обязательно пришлёт хотя бы `Origin`.
 */

export interface WriteOriginHeaders {
  /** `Sec-Fetch-Site`: `same-origin` | `same-site` | `cross-site` | `none`. */
  secFetchSite?: string | null
  /** `Origin` запроса (схема+хост+порт) — присылается браузером на кросс-сайтовые POST. */
  origin?: string | null
  /** `Host` запроса — с чем сверяем `Origin`, когда `Sec-Fetch-Site` недоступен. */
  host?: string | null
  /** `X-Forwarded-Proto`/схема — чтобы сверка `Origin` не падала на http vs https за прокси. */
  proto?: string | null
}

/** Голый хост из значения `Origin` (`https://polls.example.com:443` → `polls.example.com:443`). */
function originHost(origin: string): string | undefined {
  const m = /^https?:\/\/([^/]+)$/i.exec(origin.trim())
  return m?.[1]?.toLowerCase()
}

/**
 * Разрешён ли этот запрос на запись по происхождению. `false` — есть доказательство, что запрос
 * пришёл НЕ со страницы приложения.
 */
export function isSameOriginWrite(h: WriteOriginHeaders): boolean {
  const site = h.secFetchSite?.trim().toLowerCase()
  if (site) return site === 'same-origin'

  const origin = h.origin?.trim()
  // `null` — строковое значение заголовка у непрозрачного происхождения (sandbox-iframe, redirect):
  // это доказательство ЧУЖОГО источника, а не отсутствие заголовка.
  if (!origin) return true
  if (origin.toLowerCase() === 'null') return false

  const from = originHost(origin)
  if (!from) return false // нераспознанный Origin — не доверяем
  const host = h.host?.trim().toLowerCase()
  if (!host) return true // не с чем сверять — не отказываем (см. политику в шапке)
  // Сравниваем именно хосты: схему за reverse-proxy приложение видит не всегда, и различие
  // http/https дало бы ложные отказы на ровном месте.
  return from === host
}

/** Единый текст отказа: где произошло, что случилось, что делать. */
export const CROSS_ORIGIN_MESSAGE =
  'Запрос отклонён: он пришёл не со страницы приложения. Откройте приложение заново из Bitrix24 и повторите.'
