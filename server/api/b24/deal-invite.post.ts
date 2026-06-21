// POST /api/b24/deal-invite — создать приглашение на опрос по сделке из виджета карточки сделки
// (#17, плейсмент CRM_DEAL_DETAIL_ACTIVITY — ручной запуск, охват на всех тарифах). Конвейер:
// rate-limit → parseFrameAuth → verifyFrameAuth (SSRF-allowlist → app.info → сверка member_id) →
// crm.deal.get токеном виджета → dealToCrmContext → createSurveyInvitation (общий стор приглашений)
// → ссылка /s/:key?token=… для адресата. Fail-closed: невалидный фрейм → 401, нет сделки/версии → 422.
import { parseFrameAuth, verifyFrameAuth } from '~core/bitrix24/frame'
import { createPortalClient, dealGet, frameToB24Params } from '~core/bitrix24/client'
import { dealToCrmContext } from '~core/bitrix24/deal-event'
import { createSurveyInvitation } from '~core/bitrix24/trigger'
import { allowB24Session, useB24Authenticator } from '../../utils/b24-session'
import { useStore, useInvitations, logger } from '../../utils/api'

const DEFAULT_SURVEY = 'csat_postdeal'

export default defineEventHandler(async (event) => {
  if (!allowB24Session(getRequestIP(event) ?? '?')) {
    setResponseStatus(event, 429)
    return { ok: false, error: 'Слишком много запросов' }
  }

  const body = await readBody(event).catch(() => ({}))
  const dealId = Number((body as { dealId?: unknown }).dealId)
  const frame = parseFrameAuth(body)
  if (!frame || !Number.isInteger(dealId) || dealId <= 0) {
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
    // crm.deal.get токеном пользователя виджета → снимок контекста.
    const client = createPortalClient(
      frameToB24Params({ domain: portal.domain, accessToken: frame.AUTH_ID, memberId: portal.portalId }),
      { clientId: process.env.NUXT_B24_CLIENT_ID ?? '', clientSecret: process.env.NUXT_B24_CLIENT_SECRET ?? '' }
    )
    const deal = await dealGet(client, dealId)
    const context = dealToCrmContext(deal)

    // ⚠️ TENANT (#49): `useStore()` сейчас SINGLE-TENANT (один PgStore на инстанс приложения) —
    // приложение обслуживает ОДИН портал. Подтверждённый `portal.portalId` тут НЕ выбирает стор.
    // Для мульти-портала ОБЯЗАТЕЛЕН scoped-стор по `portal.portalId` (member_id → portal.id), иначе
    // портал A создаст приглашение в данных портала B (инвариант createSurveyInvitation). Гейт — #49.
    const store = await useStore()
    const res = await createSurveyInvitation({ store, invitations: useInvitations(), surveyKey: DEFAULT_SURVEY, context })
    if (!res) {
      setResponseStatus(event, 422)
      return { ok: false, error: 'Опрос не опубликован' }
    }
    const base = process.env.DOMAIN ? `https://${process.env.DOMAIN}` : ''
    logger.info('b24_deal_invite', { msg: `Приглашение по сделке ${dealId} (портал ${portal.portalId})` })
    return { ok: true, surveyKey: res.surveyKey, token: res.token, url: `${base}/s/${res.surveyKey}?token=${res.token}` }
  } catch (e) {
    logger.warn('b24_deal_invite_fail', { msg: `Сделка ${dealId}: ${(e as Error).message}` })
    setResponseStatus(event, 502)
    return { ok: false, error: 'Не удалось создать приглашение' }
  }
})
