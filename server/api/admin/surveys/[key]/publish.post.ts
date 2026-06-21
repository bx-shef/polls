import { surveyDraftSchema } from '~core/domain/schema'

/**
 * POST /api/admin/surveys/:key/publish — публикует НОВУЮ версию опроса из черновика админ-UI.
 * Тело — `SurveyDraft` (валидируется `surveyDraftSchema`); номер версии назначает СЕРВЕР
 * (`currentVersion + 1`, либо 1 для нового опроса) — клиент его не задаёт (иммутабельность +
 * монотонность гарантируются сервером, не доверяем телу). Ключ в URL должен совпадать с
 * `body.surveyKey` (не публикуем под чужим ключом). Ответ: `{ ok: true, versionNo }`.
 *
 * Статусы: 400 (битый ключ/JSON h3), 413 (тело > 64КБ), 409 (ключ URL≠тело), 422 (невалидный
 * черновик/дубль question_key — ядро бросает), 503 (auth не сконфигурирован). Body-limit —
 * паритет с /api/submit.
 *
 * AUTH (#47): `requirePortalSession` (fail-closed) — публикация опроса доступна лишь авторизованному
 * порталу. Tenant-scoped внутри PgStore по portalId (single-tenant MVP; мульти-тенант — #49).
 */
const MAX_BODY_BYTES = 64 * 1024

export default defineEventHandler(async (event) => {
  requirePortalSession(event)

  const len = Number(getRequestHeader(event, 'content-length') ?? 0)
  if (len > MAX_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { ok: false, error: 'Слишком большой запрос' }
  }

  const surveyKey = getRouterParam(event, 'key') ?? ''
  if (!surveyKey || surveyKey.length > 200) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Некорректный ключ опроса' }
  }

  const parsed = surveyDraftSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    setResponseStatus(event, 422)
    return { ok: false, error: 'Невалидный черновик опроса' }
  }
  if (parsed.data.surveyKey !== surveyKey) {
    setResponseStatus(event, 409)
    return { ok: false, error: 'Ключ опроса в URL не совпадает с телом' }
  }

  const store = await useStore()
  const current = await store.currentVersion(surveyKey)
  const nextVersion = (current?.versionNo ?? 0) + 1
  try {
    await store.publish(parsed.data, nextVersion)
  } catch {
    // compile/publish бросает на дублях ключей и нарушении иммутабельности (гонка версий).
    setResponseStatus(event, 422)
    return { ok: false, error: 'Не удалось опубликовать версию' }
  }
  return { ok: true as const, versionNo: nextVersion }
})
