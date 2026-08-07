import type { H3Event } from 'h3'
import {
  resolveDashboardAuth,
  resolveWriteAccess,
  ADMIN_REQUIRED_MESSAGE,
  DEV_PORTAL_ID,
  type PortalSession
} from '~core/api/session'

const SESSION_COOKIE = 'polls_portal'

let devOpenWarned = false
function warnDevOpenOnce(): void {
  if (devOpenWarned) return
  devOpenWarned = true
  // Громкое предупреждение: дашборд открыт без auth (dev/гейт). НЕ должно звучать в проде.
  console.warn('[dashboard] AUTH ВЫКЛЮЧЕН (dev-open) — не для production; задайте DASHBOARD_AUTH_SECRET')
}

/**
 * Гейт дашборда (контур B, #47): возвращает портал, от имени которого открыт дашборд, либо
 * бросает 401/503. Тонкая h3-обёртка над чистым `resolveDashboardAuth` (вся политика/тесты —
 * там). Политика fail-closed (см. `resolveDashboardAuth`): прод без валидной сессии → 401/503,
 * чтобы имена клиентов/`responsibleName`-PII не утекли. Dev/гейт — открыто по `DASHBOARD_DEV_OPEN`;
 * локальный `pnpm dev` — по `NODE_ENV !== 'production'`. Секрет имеет приоритет над dev-открытостью.
 *
 * tenant-изоляция: `portalId` — ключ арендатора; фильтрация стора по нему — на PgStore-пути (#49).
 */
export function requirePortalSession(event: H3Event): PortalSession {
  const decision = resolveDashboardAuth(
    {
      secret: process.env.DASHBOARD_AUTH_SECRET,
      devOpen: !!process.env.DASHBOARD_DEV_OPEN,
      isProduction: process.env.NODE_ENV === 'production'
    },
    getCookie(event, SESSION_COOKIE)
  )
  if (!decision.ok) {
    throw createError({
      statusCode: decision.status,
      statusMessage: decision.status === 401 ? 'Unauthorized' : 'Dashboard auth not configured'
    })
  }
  if (decision.session.portalId === DEV_PORTAL_ID) warnDevOpenOnce()
  return decision.session
}

/**
 * То же решение, что и {@link requirePortalSession}, но РЕШЕНИЕМ, а не броском. Нужно роутам, которые
 * обязаны ответить своим текстом: брошенный `createError` Nitro заворачивает в свой конверт, и клиент
 * показывает служебное значение вместо сообщения.
 *
 * `devOpen` отдаётся отдельным признаком: в этом режиме авторизации нет вовсе, и роутам, которые
 * что-то отправляют НАРУЖУ (например, отзыв в чужой трекер), синтетическую сессию принимать нельзя —
 * иначе они превращаются в анонимный релей.
 */
export function resolvePortalSession(
  event: H3Event
): { ok: true; session: PortalSession; devOpen: boolean } | { ok: false; status: 401 | 503 } {
  const decision = resolveDashboardAuth(
    {
      secret: process.env.DASHBOARD_AUTH_SECRET,
      devOpen: !!process.env.DASHBOARD_DEV_OPEN,
      isProduction: process.env.NODE_ENV === 'production'
    },
    getCookie(event, SESSION_COOKIE)
  )
  if (!decision.ok) return decision
  const devOpen = decision.session.portalId === DEV_PORTAL_ID
  if (devOpen) warnDevOpenOnce()
  return { ok: true, session: decision.session, devOpen }
}

// Текст отказа гейта записи переехал в ядро (`~core/api/session`): его длина упирается в предел
// `serverMessage`, а из `server/**` этот предел ничем не проверяется — тестов тут нет. Реэкспорт
// оставлен, чтобы роуты не переучивались, откуда его брать.
export { ADMIN_REQUIRED_MESSAGE }

/**
 * Гейт ЗАПИСИ конфигурации опросов (аналог admin-гейта настроек в соседнем `ai-price-import`, там #182):
 * сессия портала + роль администратора портала.
 *
 * Зачем отдельно от `requirePortalSession`: та отвечает лишь на вопрос «какой это портал». Пока
 * гейта роли не было, любой сотрудник портала, открывший приложение во фрейме, мог опубликовать
 * версию опроса — то есть изменить текст, который увидит клиент заказчика. Читать дашборд может
 * любой сотрудник (для этого хватает `requirePortalSession`), менять конфигурацию — только админ.
 *
 * Роль берётся из ПОДПИСАННОЙ сессии (`profile.ADMIN` на момент handshake): подделать её нельзя,
 * и каждый запрос не тратит REST к порталу. Цена — роль фиксируется на момент handshake, в ОБЕ стороны:
 * и снятые, и выданные права подействуют лишь при следующем открытии приложения (тогда сессия минтится
 * заново), а если его не открывать — то по истечении TTL сессии, максимум через 8 ч. На практике окно
 * узкое: фрейм переоткрывают часто. Случай «права выдали, а публикация всё равно 403» — самый частый
 * повод обращения в поддержку, поэтому он прямо назван в {@link ADMIN_REQUIRED_MESSAGE}.
 *
 * Возвращает решение, а НЕ бросает: роуты проекта отвечают на ошибки конвенцией
 * `setResponseStatus` + `return { ok: false, error }`. Брошенный `createError` с полем `data`
 * до клиента этим текстом не доходит — Nitro заворачивает его в свой конверт, и виджет показал бы
 * служебное значение вместо сообщения. Политика решения — чистая `resolveWriteAccess` в ядре (под тестами),
 * здесь только чтение сессии.
 */
export function resolveAdminAccess(event: H3Event): { ok: true; session: PortalSession } | { ok: false; status: 403 } {
  const session = requirePortalSession(event)
  const decision = resolveWriteAccess(session)
  return decision.ok ? { ok: true, session } : decision
}
