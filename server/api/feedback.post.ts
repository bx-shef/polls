import { buildFeedbackIssue, normalizeKind } from '~core/domain/feedback'
import { isSameOriginWrite, CROSS_ORIGIN_MESSAGE } from '~core/api/csrf'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { resolveFeedbackConfig, postFeedbackIssue } from '~core/api/feedback'
import { requirePortalSession } from '../utils/auth'
import { logger } from '../utils/api'
import { timeoutFetch } from '../utils/b24-fetch'

/**
 * POST /api/feedback — отзыв сотрудника 👍/👎 с комментарием → issue в приватном репозитории.
 *
 * **Только внутренние экраны.** Гейт — сессия портала: канал не должен быть анонимным, иначе это
 * готовый спам-канал в чужой трекер. Роли администратора не требуем: мнение о сервисе — дело любого
 * сотрудника, а не только админа.
 *
 * ⚠️ Публичная страница прохождения опроса виджет НЕ показывает и показывать не должна: там сидит
 * клиент заказчика, сессии портала у него нет, а анонимный приём отзывов — открытая дверь.
 *
 * Статусы: 400 (неизвестная оценка), 401/503 (сессия), 403 (чужое происхождение), 413 (крупное тело),
 * 429 (лимит), 502 (GitHub отверг или недоступен), 503 (канал не настроен).
 */
const MAX_BODY_BYTES = 16 * 1024

// Отзыв — редкое действие человека. Лимит защищает от залипшей кнопки и от набивания чужого трекера.
// In-memory, на инстанс (общий стор — #4).
const feedbackLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 60_000 })

export default defineEventHandler(async (event) => {
  const config = resolveFeedbackConfig()
  if (!config) {
    setResponseStatus(event, 503)
    return { ok: false, error: 'Отправка отзывов не настроена. Сообщите администратору приложения.' }
  }
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
  // Сессия портала: отзыв принимаем только от сотрудника, открывшего приложение из Bitrix24.
  requirePortalSession(event)

  if (Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { ok: false, error: 'Слишком длинный комментарий. Сократите его и отправьте снова.' }
  }
  if (!feedbackLimiter.allow(getRequestIP(event) ?? '?', new Date())) {
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

  // Контекст приходит с клиента и рендерится инертным. В нём ТОЛЬКО обезличенное — тип это
  // ограничивает (см. `FeedbackContext`): ни ответа, ни сделки, ни имён сюда попасть не может.
  const c = raw?.context ?? {}
  const payload = buildFeedbackIssue(kind, raw?.comment, {
    surveyKey: c.surveyKey,
    versionNo: c.versionNo,
    screen: c.screen,
    appVersion: c.appVersion
  })

  // Единый fetch с таймаутом: зависший GitHub иначе держал бы соединение до упора.
  const res = await postFeedbackIssue(config, payload, timeoutFetch as never)
  if (!res.ok) {
    // Ни репозитория, ни тела в лог: только статус и признак «имеет ли смысл повтор».
    logger.warn('feedback_post_failed', { status: res.status, retryable: res.retryable })
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
