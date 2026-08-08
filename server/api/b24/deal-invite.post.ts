// POST /api/b24/deal-invite — создать приглашение на опрос по сделке из виджета карточки сделки
// (#17, плейсмент CRM_DEAL_DETAIL_ACTIVITY — ручной запуск, охват на всех тарифах). Конвейер:
// rate-limit → parseFrameAuth → verifyFrameAuth (SSRF-allowlist → profile → сверка member_id) →
// crm.deal.get токеном виджета → dealToCrmContext → createSurveyInvitation (общий стор приглашений)
// → ссылка /s/:key?token=… для адресата. Fail-closed: невалидный фрейм → 401, нет сделки/версии → 422.
// Своего кап-лимита на тело нет намеренно: его держит общий бэкстоп `server/middleware/body-limit.ts`
// (128 КБ → 413, тело без заявленной длины → 411) — ровно для таких роутов он и сделан. Раньше `readBody`
// здесь шёл до подтверждения фрейма вообще без ограничения.
import { parseFrameAuth, verifyFrameAuth } from '~core/bitrix24/frame'
import { createPortalClient, dealGet, dealProductRows, frameToB24Params } from '~core/bitrix24/client'
import { dealToCrmContext } from '~core/bitrix24/deal-event'
import { createSurveyInvitation } from '~core/bitrix24/trigger'
import { surveyKeyForEntity } from '~core/bitrix24/survey-routing'
import { allowB24Session, useB24Authenticator } from '../../utils/b24-session'
import { b24AppConfig } from '../../utils/portal'
import { useStore, useInvitations, useSurveyRouting, logger } from '../../utils/api'

// Какой опрос запускать по сделке — из конфигурации портала (env `SURVEY_KEY_DEAL`/`SURVEY_KEY_DEFAULT`),
// с дефолтом. UI-маппинг entityType→surveyKey — отдельный issue.

export default defineEventHandler(async (event) => {
  if (!allowB24Session(requestIp(event))) {
    setResponseStatus(event, 429)
    return { ok: false, error: 'Слишком много запросов. Подождите немного и попробуйте снова.' }
  }

  const body = await readBody(event).catch(() => ({}))
  const dealId = Number((body as { dealId?: unknown }).dealId)
  const frame = parseFrameAuth(body)
  if (!frame || !Number.isInteger(dealId) || dealId <= 0) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Не удалось определить сделку. Откройте виджет из карточки сделки.' }
  }

  // Анти-абьюз: подтверждаем портал (домен + живой токен + сверка member_id), как /api/b24/session.
  let portal
  try {
    portal = await verifyFrameAuth(frame, { authenticate: useB24Authenticator() })
  } catch {
    setResponseStatus(event, 401)
    return { ok: false, error: 'Портал не подтверждён. Откройте виджет заново из карточки сделки.' }
  }

  try {
    // crm.deal.get токеном пользователя виджета → снимок контекста.
    const client = createPortalClient(
      frameToB24Params({ domain: portal.domain, accessToken: frame.AUTH_ID, memberId: portal.portalId }),
      { clientId: process.env.NUXT_B24_CLIENT_ID ?? '', clientSecret: process.env.NUXT_B24_CLIENT_SECRET ?? '' }
    )
    const deal = await dealGet(client, dealId)
    // Товарные позиции — best-effort (у сделки товаров может не быть / нет доступа/скоупа): без них
    // срез дашборда «услуга/товар» пуст на реальных данных (сверено вебхуком). Ошибку глушим, но ЛОГИРУЕМ —
    // иначе систематический провал productrows (нет прав/скоупа) → тихо пустой срез без диагностики.
    const productRows = await dealProductRows(client, dealId).catch((e: unknown) => {
      logger.warn('b24_deal_productrows_fail', { msg: `Сделка ${dealId}: ${(e as Error).message}` })
      return []
    })
    const context = dealToCrmContext(deal, productRows)

    // ⚠️ TENANT (#49): `useStore()` сейчас SINGLE-TENANT (один PgStore на инстанс приложения) —
    // приложение обслуживает ОДИН портал. Подтверждённый `portal.portalId` тут НЕ выбирает стор.
    // Для мульти-портала ОБЯЗАТЕЛЕН scoped-стор по `portal.portalId` (member_id → portal.id), иначе
    // портал A создаст приглашение в данных портала B (инвариант createSurveyInvitation). Гейт — #49.
    const store = await useStore()
    const { routing, fallback } = useSurveyRouting()
    const surveyKey = surveyKeyForEntity('deal', routing, fallback)
    const res = await createSurveyInvitation({ store, invitations: useInvitations(), surveyKey, context })
    if (!res) {
      setResponseStatus(event, 422)
      return { ok: false, error: 'Опрос ещё не опубликован. Опубликуйте его в разделе «Опросы» и повторите.' }
    }
    // База ссылки — из ЕДИНОЙ точки (b24AppConfig: APP_DOMAIN ?? DOMAIN), как HANDLER-URL встроек.
    // Раньше бралось только из DOMAIN → деплой на APP_DOMAIN давал относительный URL, который внутри
    // iframe-виджета разрешался бы на домен портала Bitrix (битая ссылка клиенту).
    const base = b24AppConfig()?.baseUrl ?? ''
    logger.info('b24_deal_invite', { msg: `Приглашение по сделке ${dealId} (портал ${portal.portalId})` })
    return { ok: true, surveyKey: res.surveyKey, token: res.token, url: `${base}/s/${res.surveyKey}?token=${res.token}` }
  } catch (e) {
    logger.warn('b24_deal_invite_fail', { msg: `Сделка ${dealId}: ${(e as Error).message}` })
    setResponseStatus(event, 502)
    return { ok: false, error: 'Не удалось создать ссылку на опрос. Проверьте доступ к сделке и попробуйте снова.' }
  }
})
