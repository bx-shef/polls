import { surveyDraftSchema } from '~core/domain/schema'
import { isSameOriginWrite, CROSS_ORIGIN_MESSAGE } from '~core/api/csrf'
import { logger } from '../../../../utils/api'

/**
 * POST /api/admin/surveys/:key/publish — публикует НОВУЮ версию опроса из черновика админ-UI.
 * Тело — `SurveyDraft` (валидируется `surveyDraftSchema`); номер версии назначает СЕРВЕР
 * (`currentVersion + 1`, либо 1 для нового опроса) — клиент его не задаёт (иммутабельность +
 * монотонность гарантируются сервером, не доверяем телу). Ключ в URL должен совпадать с
 * `body.surveyKey` (не публикуем под чужим ключом). Ответ: `{ ok: true, versionNo }`.
 *
 * Оптимистичная блокировка: опц. `body.expectedVersionNo` — номер текущей версии, который клиент
 * загружал в редактор. Если он разошёлся с реальной текущей (кто-то опубликовал в промежутке) →
 * 409, чтобы правка не затёрла молча чужую публикацию. Поле опционально (back-compat); читается
 * ДО `surveyDraftSchema.safeParse` (схема strip'ает неизвестные ключи, поле в черновик не утекает).
 *
 * Статусы: 400 (битый ключ/JSON h3), 401/503 (auth), 413 (тело > 64КБ), 409 (ключ URL≠тело ИЛИ
 * конфликт версии — номер уже занят), 422 (невалидный черновик/дубль question_key), 500 (инфра-сбой
 * стора — пробрасывается, не маскируется под 422). Body-limit по content-length — паритет с
 * /api/submit (отсекает обычный случай; потоковый cap для chunked-тел без заголовка — слой прокси #4).
 *
 * AUTH: `resolveAdminAccess` (fail-closed) — мало быть авторизованным порталом, нужна роль
 * АДМИНИСТРАТОРА портала (`profile.ADMIN`, снят при handshake и лежит в подписанной сессии).
 * Публикация меняет текст, который увидит клиент заказчика, поэтому право на неё уже не то же,
 * что право посмотреть дашборд. Не админ → 403. Tenant-scoped внутри PgStore по portalId
 * (single-tenant MVP; мульти-тенант — #49).
 */
const MAX_BODY_BYTES = 64 * 1024

export default defineEventHandler(async (event) => {
  // 1) Происхождение. Cookie сессии живёт с `SameSite=None` (иначе фрейм Bitrix24 её не пошлёт),
  // поэтому чужая страница может инициировать запрос с валидной cookie. Отказываем по доказательству
  // чужого источника — до чтения тела и до любой работы со стором.
  if (
    !isSameOriginWrite({
      secFetchSite: getRequestHeader(event, 'sec-fetch-site'),
      origin: getRequestHeader(event, 'origin'),
      host: getRequestHeader(event, 'host')
    })
  ) {
    setResponseStatus(event, 403)
    return { ok: false, error: CROSS_ORIGIN_MESSAGE }
  }

  // 2) Гейт роли — по конвенции этого роута (setResponseStatus + тело), а не throw: только так наш
  // русский текст доедет до виджета (`err.data.error`), как и остальные ошибки ниже.
  const access = resolveAdminAccess(event)
  if (!access.ok) {
    setResponseStatus(event, access.status)
    return { ok: false, error: ADMIN_REQUIRED_MESSAGE }
  }

  const len = Number(getRequestHeader(event, 'content-length') ?? 0)
  if (len > MAX_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { ok: false, error: 'Слишком большой объём данных.' }
  }

  const surveyKey = getRouterParam(event, 'key') ?? ''
  if (!surveyKey || surveyKey.length > 200) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Неверный адрес опроса. Проверьте ссылку.' }
  }

  const rawBody = await readBody(event)
  // expectedVersionNo читаем ДО парса черновика (схема его strip'ает). undefined/NaN → проверку пропускаем.
  const rawExpected = (rawBody as { expectedVersionNo?: unknown } | null)?.expectedVersionNo
  const expectedVersionNo = typeof rawExpected === 'number' && Number.isInteger(rawExpected) ? rawExpected : undefined

  const parsed = surveyDraftSchema.safeParse(rawBody)
  if (!parsed.success) {
    setResponseStatus(event, 422)
    return { ok: false, error: 'В опросе есть ошибки. Исправьте их и опубликуйте снова.' }
  }
  if (parsed.data.surveyKey !== surveyKey) {
    setResponseStatus(event, 409)
    return { ok: false, error: 'Адрес опроса не совпадает. Обновите страницу и повторите.' }
  }

  // TENANT (#49): publish идёт в стор ПРОЦЕССА (single-tenant MVP — один процесс = один портал).
  // При мульти-тенанте сюда придёт `useStore(session.portalId)` — портал берётся из авторитетной
  // сессии (session.portalId), не из тела/URL.
  const store = await useStore()
  const current = await store.currentVersion(surveyKey)
  const currentNo = current?.versionNo ?? 0
  // Оптимистичная блокировка: клиент загружал currentNo'; если реальная текущая ушла вперёд — конфликт.
  if (expectedVersionNo !== undefined && expectedVersionNo !== currentNo) {
    setResponseStatus(event, 409)
    return { ok: false, error: 'Опрос изменил кто-то ещё. Обновите страницу и опубликуйте заново.' }
  }
  const nextVersion = currentNo + 1
  try {
    await store.publish(parsed.data, nextVersion)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    // Конфликт версии (гонка/иммутабельность: номер уже занят) — 409, клиент перечитает и повторит.
    if (/уже опубликована/.test(msg) || /version_no/i.test(msg) || /unique/i.test(msg)) {
      setResponseStatus(event, 409)
      return { ok: false, error: 'Эта версия уже опубликована. Обновите страницу и опубликуйте заново.' }
    }
    // Невалидный черновик, который не ловит схема (дубль question_key/option_key, versionNo) — 422.
    if (/Дублирующ/.test(msg) || /versionNo/.test(msg)) {
      setResponseStatus(event, 422)
      return { ok: false, error: 'В опросе есть ошибки. Исправьте их и опубликуйте снова.' }
    }
    // Прочее (инфра: БД недоступна и т.п.) — НЕ маскируем под 422: логируем и пробрасываем (→500 h3).
    logger.error('admin_publish_fail', { surveyKey, versionNo: nextVersion, err: msg })
    throw e
  }
  return { ok: true as const, versionNo: nextVersion }
})
