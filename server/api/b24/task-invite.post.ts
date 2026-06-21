// POST /api/b24/task-invite — создать приглашение на опрос по задаче из виджета карточки задачи
// (плейсмент TASK_VIEW_SIDEBAR — ручной запуск; у задачи нет стадии воронки, только вручную). Конвейер
// зеркалит deal-invite: rate-limit → parseFrameAuth → verifyFrameAuth (SSRF-allowlist → app.info →
// сверка member_id) → tasks.task.get токеном виджета → taskToCrmContext → createSurveyInvitation
// (общий стор приглашений) → ссылка /s/:key?token=… для адресата. Fail-closed: невалидный фрейм → 401.
import { parseFrameAuth, verifyFrameAuth } from '~core/bitrix24/frame'
import { createPortalClient, taskGet, frameToB24Params } from '~core/bitrix24/client'
import { taskToCrmContext } from '~core/bitrix24/task'
import { parsePlacementTaskId } from '~core/bitrix24/install'
import { createSurveyInvitation } from '~core/bitrix24/trigger'
import { allowB24Session, useB24Authenticator } from '../../utils/b24-session'
import { useStore, useInvitations, logger } from '../../utils/api'

// Какой опрос запускать с карточки задачи. Хардкод (паритет с deal-invite); конфиг «entityType →
// surveyKey» — отдельный issue (см. docs/issues.md).
const DEFAULT_SURVEY = 'csat_postdeal'

export default defineEventHandler(async (event) => {
  if (!allowB24Session(getRequestIP(event) ?? '?')) {
    setResponseStatus(event, 429)
    return { ok: false, error: 'Слишком много запросов' }
  }

  const body = (await readBody(event).catch(() => ({}))) as { taskId?: unknown; PLACEMENT_OPTIONS?: unknown }
  // taskId: из явного поля (виджет распарсил placement options client-side) ИЛИ fallback — из сырых
  // PLACEMENT_OPTIONS через ядровой парсер (терпим к JSON-строке/ключам taskId/TASK_ID/ID).
  const taskId = (Number.isInteger(Number(body.taskId)) && Number(body.taskId) > 0
    ? Number(body.taskId)
    : parsePlacementTaskId(body.PLACEMENT_OPTIONS)) ?? 0
  const frame = parseFrameAuth(body)
  if (!frame || !Number.isInteger(taskId) || taskId <= 0) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Некорректные параметры виджета' }
  }

  // Анти-абьюз: подтверждаем портал (домен + живой токен + сверка member_id), как /api/b24/session.
  let portal
  try {
    portal = await verifyFrameAuth(frame, { authenticate: useB24Authenticator() })
  } catch {
    setResponseStatus(event, 401)
    return { ok: false, error: 'Портал не подтверждён' }
  }

  try {
    // tasks.task.get токеном пользователя виджета → снимок контекста (responsibleId + CRM-привязки).
    const client = createPortalClient(
      frameToB24Params({ domain: portal.domain, accessToken: frame.AUTH_ID, memberId: portal.portalId }),
      { clientId: process.env.NUXT_B24_CLIENT_ID ?? '', clientSecret: process.env.NUXT_B24_CLIENT_SECRET ?? '' }
    )
    const task = await taskGet(client, taskId)
    const context = taskToCrmContext(task)

    // ⚠️ TENANT (#49): `useStore()` сейчас SINGLE-TENANT (один PgStore на инстанс) — приложение
    // обслуживает ОДИН портал. Для мульти-портала ОБЯЗАТЕЛЕН scoped-стор по `portal.portalId`
    // (member_id → portal.id), иначе cross-tenant (инвариант createSurveyInvitation). Гейт — #49.
    const store = await useStore()
    const res = await createSurveyInvitation({ store, invitations: useInvitations(), surveyKey: DEFAULT_SURVEY, context })
    if (!res) {
      setResponseStatus(event, 422)
      return { ok: false, error: 'Опрос не опубликован' }
    }
    const base = process.env.DOMAIN ? `https://${process.env.DOMAIN}` : ''
    logger.info('b24_task_invite', { msg: `Приглашение по задаче ${taskId} (портал ${portal.portalId})` })
    return { ok: true, surveyKey: res.surveyKey, token: res.token, url: `${base}/s/${res.surveyKey}?token=${res.token}` }
  } catch (e) {
    logger.warn('b24_task_invite_fail', { msg: `Задача ${taskId}: ${(e as Error).message}` })
    setResponseStatus(event, 502)
    return { ok: false, error: 'Не удалось создать приглашение' }
  }
})
