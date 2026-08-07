import type { H3Event } from 'h3'
import { resolveDashboardAuth, DEV_PORTAL_ID, type PortalSession } from '~core/api/session'

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
 * Гейт ЗАПИСИ конфигурации опросов (#182-аналог): сессия портала + роль администратора портала.
 *
 * Зачем отдельно от `requirePortalSession`: та отвечает лишь на вопрос «какой это портал». Пока
 * гейта роли не было, любой сотрудник портала, открывший приложение во фрейме, мог опубликовать
 * версию опроса — то есть изменить текст, который увидит клиент заказчика. Читать дашборд может
 * любой сотрудник (для этого хватает `requirePortalSession`), менять конфигурацию — только админ.
 *
 * Роль берётся из ПОДПИСАННОЙ сессии (`profile.ADMIN` на момент handshake): подделать её нельзя,
 * и каждый запрос не тратит REST к порталу. Цена — роль «залипает» на срок сессии (8 ч): снятие
 * прав вступит в силу после её истечения. Отсутствие поля = НЕ админ (fail-closed для сессий,
 * выписанных до появления гейта).
 */
export function requireAdminSession(event: H3Event): PortalSession {
  const session = requirePortalSession(event)
  if (session.admin !== true) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: { ok: false, error: 'Менять опросы может только администратор портала Bitrix24. Обратитесь к нему.' }
    })
  }
  return session
}
