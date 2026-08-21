import { dashboardAuthMessage } from '~core/api/session'

/**
 * GET /api/admin/surveys — список опросов портала для админ-экрана (фаза мульти-сущность).
 * Лёгкая сводка по текущей версии каждого опроса (`IStore.listSurveys`): ключ/заголовок/версия +
 * привязка-датчик (entityType/spaEntityTypeId/triggerStages) — основа списка с фильтром по
 * сущности/направлению (макет на основе шаблонов печатных форм Bitrix24).
 *
 * Ответ: `{ ok: true, surveys: SurveySummary[], admin: boolean }`. Флаг `admin` — чтобы интерфейс не
 * показывал кнопки публикации тому, кому сервер всё равно ответит 403 (правду решает сервер,
 * `requireAdminSession`; здесь — только чтобы не обещать пользователю невозможное).
 *
 * AUTH (#47): `requirePortalSession` (синхронный throw `createError`, поэтому без `await`) — прод
 * (`DASHBOARD_AUTH_SECRET`) требует валидную подписанную сессию портала, иначе 401/503 (конфигурация
 * опросов — внутренняя, не для анонима; fail-closed). Dev/гейт — открыто. Стор берётся ПО ПОРТАЛУ
 * сессии (`resolveSessionPortal` → `storeFor`): список опросов у каждого портала свой. Rate-limit
 * этого роута — #49 (пока без лимита, как dashboard).
 */
export default defineEventHandler(async (event) => {
  // `session.portalId` — и есть выбор арендатора: список опросов у каждого портала свой.
  const session = requirePortalSession(event)
  const tenant = await resolveSessionPortal(session)
  if (!tenant.ok) {
    setResponseStatus(event, tenant.status)
    return { ok: false, error: dashboardAuthMessage(tenant.status) }
  }
  const store = await storeFor(tenant.portalId)
  const surveys = await store.listSurveys()
  return { ok: true as const, surveys, admin: session.admin === true }
})
