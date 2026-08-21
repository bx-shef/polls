import { dashboardDecision } from '../../utils/dashboard-view'
import { dashboardLimiter } from '../../utils/dashboard-limit'

/**
 * GET /api/dashboard/:key — агрегаты опроса для дашборда (контур B).
 *
 * ⚠️ Роут НИЧЕГО не решает: он только собирает вход (адрес, ключ опроса, `?version`), подставляет
 * боевые зависимости и переносит решение в HTTP. Порядок проверок — лимит до работы, портал только
 * из подписанной сессии, тенант до выбора стора, анонимность до цифр — живёт в
 * `server/utils/dashboard-view.ts` и покрыт исполняемыми тестами исходов: у `server/**` порога
 * покрытия нет, а греп-гард порядок отличить не может.
 *
 * Что именно считается и почему так — там же, в `dashboardDecision`.
 */
export default defineEventHandler(async (event) => {
  const outcome = await dashboardDecision(
    {
      ip: requestIp(event),
      surveyKey: getRouterParam(event, 'key') ?? '',
      version: getQuery(event).version
    },
    {
      allowIp: (ip) => dashboardLimiter.allowIp(ip),
      allowPortal: (portalId) => dashboardLimiter.allowPortal(portalId),
      session: () => resolvePortalSession(event),
      tenant: (session) => resolveSessionPortal(session),
      storeFor: (portalId) => storeFor(portalId)
    }
  )
  setResponseStatus(event, outcome.status)
  return outcome.body
})
