import { publishableDraftSchema, draftTooLargeIssue } from '~core/domain/schema'
import { isSameOriginWrite, CROSS_ORIGIN_MESSAGE } from '~core/api/csrf'
import { PORTAL_GONE_MESSAGE } from '~core/api/session'
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
 * /api/submit; срабатывает первым (общий бэкстоп — 128 КБ), chunked-тело без заявленной длины отсекает
 * раньше него бэкстоп `server/middleware/body-limit.ts` (411), до маршрутизации.
 * Размер черновика ограничен в ядре — схемой ГРАНИЦЫ ЗАПИСИ `publishableDraftSchema`
 * (`MAX_DRAFT_BYTES`, 60 КБ). Именно она, а не общая `surveyDraftSchema`: та же схема читает версию
 * обратно в редактор, и предел на ней запер бы уже опубликованные большие опросы (открыть нельзя ⇒
 * сократить нельзя). Предел меряет РАЗОБРАННОЕ значение, кап выше — провод; одно из другого не следует.
 * Отказ по размеру отделён от прочих ошибок схемы: 413 с числами («X КБ при пределе Y»), потому что
 * это упёршийся предел, а не ошибка заполнения, и без чисел совет «сократите» невыполним.
 *
 * AUTH: `resolveAdminAccess` (fail-closed) — мало быть авторизованным порталом, нужна роль
 * АДМИНИСТРАТОРА портала (`profile.ADMIN`, снят при handshake и лежит в подписанной сессии).
 * Публикация меняет текст, который увидит клиент заказчика, поэтому право на неё уже не то же,
 * что право посмотреть дашборд. Не админ → 403. Портал — из подписанной сессии
 * (`resolveSessionPortal` → `storeFor`), не из тела и не из URL.
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

  const parsed = publishableDraftSchema.safeParse(rawBody)
  if (!parsed.success) {
    // Упёршийся предел размера — не ошибка заполнения: человеку нужны числа, иначе «сократите»
    // невыполнимо. 413, а не 422: это про объём, и статус совпадает с тем, чем ответил бы кап тела,
    // если бы черновик перевалил и его.
    const tooLarge = draftTooLargeIssue(parsed.error)
    if (tooLarge) {
      setResponseStatus(event, 413)
      return { ok: false, error: tooLarge }
    }
    setResponseStatus(event, 422)
    return { ok: false, error: 'В опросе есть ошибки. Исправьте их и опубликуйте снова.' }
  }
  if (parsed.data.surveyKey !== surveyKey) {
    setResponseStatus(event, 409)
    return { ok: false, error: 'Адрес опроса не совпадает. Обновите страницу и повторите.' }
  }

  // TENANT (#49): портал берётся из АВТОРИТЕТНОЙ сессии (`access.session.portalId` — `member_id`,
  // проверенный при handshake), а не из тела или URL. Иначе публикация под чужим ключом означала бы
  // публикацию в чужой портал: текст, который увидит клиент другого заказчика.
  const tenant = await resolveSessionPortal(access.session)
  if (!tenant.ok) {
    setResponseStatus(event, tenant.status)
    return { ok: false, error: PORTAL_GONE_MESSAGE }
  }
  const store = await storeFor(tenant.portalId)
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
