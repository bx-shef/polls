import { versionToDraft } from '~core/domain/compile'
import { dashboardAuthMessage } from '~core/api/session'

/**
 * GET /api/admin/surveys/:key — текущая версия опроса как РЕДАКТИРУЕМЫЙ черновик (для админ-UI:
 * «открыть опрос на правку»). Через ядровой `versionToDraft` (обратная проекция: без versionNo/
 * compiledAt, СОХРАНЯЯ invitationPolicy — админу нужна привязка-датчик). 404, если опроса нет.
 * Ответ: `{ ok: true, draft: SurveyDraft, currentVersionNo, admin }`. Флаг `admin` — чтобы редактор
 * открывался только для чтения у неадминистратора (публикацию сервер всё равно отвергнет 403). Клиент ХРАНИТ `currentVersionNo`
 * до публикации — основа для детекта конфликта (оптимистичная блокировка в будущем).
 * Статусы: 400 (битый ключ), 401/503 (auth), 404 (опрос не найден).
 *
 * AUTH (#47): `requirePortalSession` (fail-closed) — конфигурация опроса внутренняя. Стор берётся
 * ПО ПОРТАЛУ сессии (`resolveSessionPortal` → `storeFor`): чужой опрос по прямому адресу не откроется
 * даже с валидной сессией другого портала — ответ будет 404, как для несуществующего.
 */
export default defineEventHandler(async (event) => {
  const session = requirePortalSession(event)
  const tenant = await resolveSessionPortal(session)
  if (!tenant.ok) {
    setResponseStatus(event, tenant.status)
    return { ok: false, error: dashboardAuthMessage(tenant.status) }
  }
  const surveyKey = getRouterParam(event, 'key') ?? ''
  if (!surveyKey || surveyKey.length > 200) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Неверный адрес опроса. Проверьте ссылку.' }
  }
  const store = await storeFor(tenant.portalId)
  const version = await store.currentVersion(surveyKey)
  if (!version) {
    setResponseStatus(event, 404)
    return { ok: false, error: 'Опрос не найден. Вернитесь к списку опросов.' }
  }
  return {
    ok: true as const,
    draft: versionToDraft(version),
    currentVersionNo: version.versionNo,
    admin: session.admin === true
  }
})
