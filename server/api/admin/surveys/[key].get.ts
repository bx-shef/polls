import { versionToDraft } from '~core/domain/compile'

/**
 * GET /api/admin/surveys/:key — текущая версия опроса как РЕДАКТИРУЕМЫЙ черновик (для админ-UI:
 * «открыть опрос на правку»). Через ядровой `versionToDraft` (обратная проекция: без versionNo/
 * compiledAt, СОХРАНЯЯ invitationPolicy — админу нужна привязка-датчик). 404, если опроса нет.
 * Ответ: `{ ok: true, draft: SurveyDraft, currentVersionNo }`.
 *
 * AUTH (#47): `requirePortalSession` (fail-closed) — конфигурация опроса внутренняя.
 * Tenant-scoped внутри PgStore по portalId (single-tenant MVP; мульти-тенант — #49).
 */
export default defineEventHandler(async (event) => {
  requirePortalSession(event)
  const surveyKey = getRouterParam(event, 'key') ?? ''
  if (!surveyKey || surveyKey.length > 200) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Некорректный ключ опроса' }
  }
  const store = await useStore()
  const version = await store.currentVersion(surveyKey)
  if (!version) {
    setResponseStatus(event, 404)
    return { ok: false, error: 'Опрос не найден' }
  }
  return { ok: true as const, draft: versionToDraft(version), currentVersionNo: version.versionNo }
})
