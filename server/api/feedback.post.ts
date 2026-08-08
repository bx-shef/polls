import { createHash } from 'node:crypto'
import { buildFeedbackIssue, normalizeKind, pickFeedbackContext } from '~core/domain/feedback'
import { isSameOriginWrite, CROSS_ORIGIN_MESSAGE } from '~core/api/csrf'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { resolveFeedbackConfig, postFeedbackIssue, assertPrivateRepo } from '~core/api/feedback'
import { resolvePortalSession } from '../utils/auth'
import { logger } from '../utils/api'
import { timeoutFetch } from '../utils/b24-fetch'

/**
 * POST /api/feedback — отзыв сотрудника 👍/👎 с комментарием → issue в приватном репозитории.
 *
 * **Только из-под сессии портала.** Канал не должен быть анонимным, иначе это готовый релей в чужой
 * трекер. Роли администратора не требуем: мнение о сервисе — дело любого сотрудника.
 *
 * ⚠️ **Dev-открытый режим отвергаем отдельно.** Без `DASHBOARD_AUTH_SECRET` (или с `DASHBOARD_DEV_OPEN`)
 * сессия выдаётся кому угодно без cookie — для чтения демо-дашборда это осознанный режим, но здесь он
 * превратил бы канал в анонимный релей: любой из интернета писал бы issue в трекер владельца. Гард
 * происхождения тут не спасает — не-браузерный клиент просто не шлёт `Origin`.
 *
 * ⚠️ Публичная страница прохождения опроса виджет НЕ показывает: там клиент заказчика.
 *
 * Статусы: 400 (неизвестная оценка), 401 (нет/истекла сессия), 403 (чужое происхождение или dev-режим),
 * 411 (тело без длины), 413 (крупное тело), 429 (лимит), 502 (GitHub отверг или недоступен),
 * 503 (канал не настроен или приёмник не подтверждён приватным).
 */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Лимит. Ключ — портал, а не IP: за общим reverse-proxy все клиенты приходят с одного адреса, и лимит
 * по IP выродился бы в ОДИН счётчик на весь сервис — один шумный отправитель закрыл бы канал остальным.
 * In-memory, на инстанс (общий стор — #4).
 */
const feedbackLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 60_000 })

/**
 * Псевдоним портала для issue: солёный хеш, по которому нельзя восстановить ни портал, ни человека,
 * но можно увидеть «это те же самые жалобы» и связать с логами.
 *
 * Солим секретом сессии: он и так обязан быть сильным, отдельной переменной заводить не за чем.
 * Секрета нет — псевдонима не будет (в dev-режиме мы сюда всё равно не доходим).
 */
function portalAlias(portalId: string): string | undefined {
  const salt = process.env.DASHBOARD_AUTH_SECRET
  if (!salt) return undefined
  return createHash('sha256').update(`${salt}:${portalId}`).digest('hex').slice(0, 12)
}

export default defineEventHandler(async (event) => {
  // Происхождение — до чтения тела и до любой работы: cookie живёт с SameSite=None.
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

  // Сессия — РАНЬШЕ проверки настроек: иначе анонимный запрос узнавал бы по коду ответа, настроен ли
  // на этом развёртывании канал. Отвечаем телом, а не throw, чтобы текст доехал до виджета.
  const session = resolvePortalSession(event)
  if (!session.ok) {
    setResponseStatus(event, session.status)
    return {
      ok: false,
      error:
        session.status === 401
          ? 'Отправка отзыва: сессия портала истекла. Закройте и заново откройте приложение из Bitrix24.'
          : 'Отправка отзыва недоступна: приложение не настроено. Сообщите администратору.'
    }
  }
  if (session.devOpen) {
    // Демо-режим без авторизации: отправлять от его имени наружу нельзя.
    setResponseStatus(event, 403)
    return {
      ok: false,
      error: 'Отправка отзыва доступна только из приложения, открытого в Bitrix24.'
    }
  }

  const config = resolveFeedbackConfig()
  if (!config) {
    setResponseStatus(event, 503)
    return { ok: false, error: 'Отправка отзывов не настроена. Сообщите администратору приложения.' }
  }

  const len = getRequestHeader(event, 'content-length')
  if (len === undefined) {
    // Тело без заявленной длины (chunked) прошло бы мимо капа: `readBody` буферизует его целиком.
    // Эта ветка появилась здесь раньше остальных и стала образцом для общего бэкстопа
    // (`server/middleware/body-limit.ts`), который теперь отсекает такой запрос ещё до маршрутизации.
    setResponseStatus(event, 411)
    return { ok: false, error: 'Не удалось принять отзыв: не указан размер запроса. Обновите страницу.' }
  }
  if (!(Number(len) <= MAX_BODY_BYTES)) {
    setResponseStatus(event, 413)
    return { ok: false, error: 'Слишком длинный комментарий. Сократите его и отправьте снова.' }
  }
  if (!feedbackLimiter.allow(session.session.portalId, new Date())) {
    setResponseStatus(event, 429)
    return { ok: false, error: 'Слишком много отзывов подряд. Подождите минуту и попробуйте снова.' }
  }

  const raw = (await readBody(event).catch(() => null)) as
    | { kind?: unknown; comment?: unknown; context?: Record<string, unknown> }
    | null
  const kind = normalizeKind(raw?.kind)
  if (!kind) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Не удалось распознать оценку. Нажмите 👍 или 👎 ещё раз.' }
  }

  // Приёмник обязан быть ПРИВАТНЫМ — проверяем вживую, а не верим настройке: одна опечатка
  // (публичный репозиторий с кодом) отправила бы текст сотрудника в открытый интернет.
  if (!(await assertPrivateRepo(config, timeoutFetch))) {
    logger.error('feedback_repo_not_private', {
      detail: 'репозиторий-приёмник не подтверждён приватным — отзывы не отправляются (проверьте GITHUB_FEEDBACK_REPO и права токена)'
    })
    setResponseStatus(event, 503)
    return { ok: false, error: 'Отправка отзывов временно недоступна. Сообщите администратору приложения.' }
  }

  // Контекст приходит с клиента: ограничиваем и ИМЕНА полей, и ЗНАЧЕНИЯ (аллоулист — в ядре, под
  // тестами). Псевдоним портала ставит сервер из сессии — клиент на него не влияет.
  const payload = buildFeedbackIssue(kind, raw?.comment, {
    ...pickFeedbackContext(raw?.context),
    portalAlias: portalAlias(session.session.portalId)
  })

  const res = await postFeedbackIssue(config, payload, timeoutFetch)
  if (!res.ok) {
    // Ни репозитория, ни тела в лог: только статус и признак «имеет ли смысл повтор».
    // Отказ по правам/настройке — `error`: чинить его должен владелец, а не пользователь.
    const fields = { status: res.status, retryable: res.retryable }
    if (res.status === 401 || res.status === 403) logger.error('feedback_auth_rejected', fields)
    else logger.warn('feedback_post_failed', fields)
    setResponseStatus(event, 502)
    return {
      ok: false,
      error: res.retryable
        ? 'Не удалось отправить отзыв: сервис отзывов сейчас недоступен. Попробуйте позже.'
        : 'Не удалось отправить отзыв. Сообщите администратору приложения.'
    }
  }
  return { ok: true as const }
})
