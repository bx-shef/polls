/**
 * GET /api/admin/surveys — список опросов портала для админ-экрана (фаза мульти-сущность).
 * Лёгкая сводка по текущей версии каждого опроса (`IStore.listSurveys`): ключ/заголовок/версия +
 * привязка-датчик (entityType/spaEntityTypeId/triggerStages) — основа списка с фильтром по
 * сущности/направлению (макет на основе шаблонов печатных форм Bitrix24).
 *
 * AUTH (#47): `requirePortalSession` — прод (`DASHBOARD_AUTH_SECRET`) требует валидную подписанную
 * сессию портала, иначе 401/503 (конфигурация опросов — внутренняя, не для анонима; fail-closed).
 * Dev/гейт — открыто. Tenant-фильтрация стора по portalId — на PgStore-пути (#49); сейчас один
 * стор на процесс (single-tenant MVP), листинг уже tenant-scoped внутри PgStore по portalId.
 */
export default defineEventHandler(async (event) => {
  requirePortalSession(event)
  const store = await useStore()
  const surveys = await store.listSurveys()
  return { ok: true as const, surveys }
})
