import { dashboardDecision } from '../../utils/dashboard-view'
import { dashboardLimiter } from '../../utils/dashboard-limit'

/**
 * GET /api/dashboard/:key — агрегаты опроса для дашборда (контур B).
 *
 * ⚠️ Роут НИЧЕГО не решает: он только собирает вход (ключ опроса, `?version`), подставляет боевые
 * зависимости и переносит решение в HTTP. Порядок проверок — портал только из подписанной сессии,
 * тенант до выбора стора, потолок до чтения ответов, анонимность до цифр — живёт в
 * `server/utils/dashboard-view.ts` и покрыт исполняемыми тестами исходов: у `server/**` порога
 * покрытия нет, а греп-гард порядок отличить не может.
 *
 * Что именно считается и почему так — там же, в `dashboardDecision`.
 */
export default defineEventHandler(async (event) => {
  // ⚠️ Тело — авторизованный по cookie срез с ИМЕНАМИ клиентов и сотрудников (`breakdownBy`), плюс
  // оно зависит от состояния лимитера (429 против 200). Без явной директивы общий кэш вправе
  // переиспользовать ответ — тот же довод, по которому `no-store` стоит на контуре A.
  setResponseHeader(event, 'cache-control', 'private, no-store')

  const outcome = await dashboardDecision(
    {
      surveyKey: getRouterParam(event, 'key') ?? '',
      version: getQuery(event).version
    },
    {
      allowPortal: (portalId) => dashboardLimiter.allowPortal(portalId),
      session: () => resolvePortalSession(event),
      tenant: (session) => resolveSessionPortal(session),
      storeFor: (portalId) => storeFor(portalId)
    }
  )
  // Окно лимитера — 60 секунд, и оно одно на оба потолка: заголовок не говорит, какой сработал.
  // Без него страница во фрейме отличается «сама починится через минуту» от «жать F5, тратя окно».
  if (outcome.status === 429) setResponseHeader(event, 'retry-after', 60)
  setResponseStatus(event, outcome.status)
  return outcome.body
})
