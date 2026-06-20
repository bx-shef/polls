import type { H3Event } from 'h3'
import { verifySession, type PortalSession } from '~core/api/session'

const SESSION_COOKIE = 'polls_portal'
const DEV_PORTAL = 'dev'

/**
 * Гейт дашборда (контур B, #47): возвращает портал, от имени которого открыт дашборд, либо
 * бросает 401/503. Политика (fail-closed для прода — чтобы не утекли имена клиентов/сотрудников):
 *  - `DASHBOARD_AUTH_SECRET` задан → ТРЕБУЕМ валидную подписанную сессию (cookie `polls_portal`),
 *    иначе 401. Это боевой путь (сессию минтит handshake Bitrix24 — следующий слайс #47).
 *  - секрета нет, но `DASHBOARD_DEV_OPEN` ИЛИ окружение не `production` → открыто (portalId='dev'):
 *    локальный `pnpm dev` и визуальный гейт работают без auth.
 *  - секрета нет И `production` без `DASHBOARD_DEV_OPEN` → 503 (отказ обслуживать неконфигуренный
 *    auth — безопасный дефолт, а не тихая утечка PII).
 *
 * tenant-изоляция: `portalId` — ключ арендатора; реальная фильтрация стора по нему — на PgStore-пути
 * (dev-стор `MemoryStore` одно-tenant, #49). Здесь устанавливается seam: кто спрашивает.
 */
export function requirePortalSession(event: H3Event): PortalSession {
  const secret = process.env.DASHBOARD_AUTH_SECRET
  if (secret) {
    const token = getCookie(event, SESSION_COOKIE)
    const session = token ? verifySession(token, secret) : null
    if (!session) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
    return session
  }
  if (process.env.DASHBOARD_DEV_OPEN || process.env.NODE_ENV !== 'production') {
    return { portalId: DEV_PORTAL, exp: Math.floor(Date.now() / 1000) + 3600 }
  }
  throw createError({ statusCode: 503, statusMessage: 'Dashboard auth not configured' })
}
