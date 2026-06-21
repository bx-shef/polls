/**
 * GET /api/admin/surveys — список опросов портала для админ-экрана (фаза мульти-сущность).
 * Лёгкая сводка по текущей версии каждого опроса (`IStore.listSurveys`): ключ/заголовок/версия +
 * привязка-датчик (entityType/spaEntityTypeId/triggerStages) — основа списка с фильтром по
 * сущности/направлению (макет на основе шаблонов печатных форм Bitrix24).
 *
 * Ответ: `{ ok: true, surveys: SurveySummary[] }`.
 *
 * AUTH (#47): `requirePortalSession` (синхронный throw `createError`, поэтому без `await`) — прод
 * (`DASHBOARD_AUTH_SECRET`) требует валидную подписанную сессию портала, иначе 401/503 (конфигурация
 * опросов — внутренняя, не для анонима; fail-closed). Dev/гейт — открыто. Сейчас один стор на
 * процесс (single-tenant MVP), листинг уже tenant-scoped внутри PgStore по portalId; мульти-тенант
 * (`useStore(session.portalId)`) + rate-limit этого роута — #49 (пока без лимита, как dashboard).
 */
export default defineEventHandler(async (event) => {
  // session.portalId здесь пока не используется (single-tenant стор); при мульти-тенанте (#49)
  // именно он выберет scoped-стор — поэтому гейт обязателен и сейчас (fail-closed).
  requirePortalSession(event)
  const store = await useStore()
  const surveys = await store.listSurveys()
  return { ok: true as const, surveys }
})
