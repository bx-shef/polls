// POST /api/b24/robot — робот автоматизации «Запустить опрос» (#122). Второй путь триггера рядом с
// event.bind: робот встаёт в автоматизацию СТАДИИ и вызывается ровно НА ВХОДЕ в неё, поэтому здесь НЕ
// нужна проверка истории стадий (в отличие от /api/b24/deal-update, куда событие приходит на любой апдейт).
// Взамен робот доступен не на всех тарифах — какой путь использовать, выбирает оператор.
// Формат тела — как у событий: form-urlencoded с bracket-нотацией (`document_id[0]=crm&auth[member_id]=…`),
// поэтому сначала parseBracketForm, затем ядровой runRobotTrigger: parseRobotEvent → dealIdFromDocumentId →
// verifyApplicationToken (constant-time) → crm.deal.get ТОКЕНОМ ПОРТАЛА → handleDealTrigger.
// ВСЕГДА 200: bizproc повторов не гарантирует, а форджери/мисконфиг наружу не раскрываем (только лог).
import { runRobotTrigger } from '~core/bitrix24/robot'
import { parseBracketForm } from '~core/bitrix24/bracket-form'
import { Bitrix24OAuth } from '~core/bitrix24/oauth'
import { createPortalClient, dealGet, dealProductRows, frameToB24Params } from '~core/bitrix24/client'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { usePortalTokenStore, b24AppConfig } from '../../utils/portal'
import { timeoutFetch } from '../../utils/b24-fetch'
import { useStore, useInvitations, logger } from '../../utils/api'

// Публичный роут: до сверки токена каждый запрос делает SELECT (+ расшифровку blob) — режем флуд.
// Потолок ниже, чем у deal-update: робот срабатывает на переходах стадий, а не на каждом апдейте.
const robotLimiter = new SlidingWindowLimiter({ limit: 120, windowMs: 60_000 })

export default defineEventHandler(async (event) => {
  if (!robotLimiter.allow(getRequestIP(event) ?? '?', new Date())) {
    logger.warn('b24_robot_ratelimited', { msg: 'превышен лимит роут-робота' })
    setResponseStatus(event, 200)
    return 'ok'
  }

  const body = await readBody(event).catch(() => ({}))
  const raw = parseBracketForm((body && typeof body === 'object' ? body : {}) as Record<string, unknown>)

  try {
    const cfg = b24AppConfig()
    const tokenStore = await usePortalTokenStore()
    if (!cfg || !tokenStore) {
      logger.warn('b24_robot_no_config', { msg: 'интеграция не сконфигурирована (cfg/tokenStore)' })
      setResponseStatus(event, 200)
      return 'ok'
    }

    const oauth = new Bitrix24OAuth({
      clientId: cfg.secret.clientId,
      clientSecret: cfg.secret.clientSecret,
      fetch: timeoutFetch
    })

    // ⚠️ TENANT (#49): SINGLE-TENANT, как и deal-update — `member_id` не выбирает стор.
    const store = await useStore()
    const outcome = await runRobotTrigger(raw, {
      storedApplicationToken: async (memberId) => (await tokenStore.load(memberId))?.applicationToken,
      fetchDeal: async (dealId, memberId) => {
        const tokens = await tokenStore.load(memberId)
        const accessToken = await tokenStore.accessToken(memberId, oauth)
        if (!tokens?.domain || !accessToken) throw new Error(`портал ${memberId}: токен/домен недоступен`)
        const client = createPortalClient(
          frameToB24Params({ domain: tokens.domain, accessToken, memberId }),
          cfg.secret
        )
        const deal = await dealGet(client, dealId)
        const productRows = await dealProductRows(client, dealId).catch((e: unknown) => {
          logger.warn('b24_deal_productrows_fail', { msg: `Сделка ${dealId}: ${(e as Error).message}` })
          return []
        })
        return { deal, productRows }
      },
      store,
      invitations: useInvitations()
    })

    if (outcome.kind === 'ignored') {
      // Логируем КЛЮЧИ (не значения) — так дрейф wire-формата робота виден в проде.
      logger.warn('b24_robot_ignored', { msg: `не распознано (${outcome.reason}); ключи: ${Object.keys(raw).join(',')}` })
    } else if (outcome.kind === 'forged') {
      logger.warn('b24_robot_reject', { reason: outcome.reason, memberId: outcome.memberId })
    } else {
      logger.info('b24_robot', { msg: `сделка ${outcome.dealId}: создано приглашений ${outcome.results.length}` })
    }
  } catch (e) {
    logger.warn('b24_robot_fail', { msg: (e as Error).message })
  }

  setResponseStatus(event, 200)
  return 'ok'
})
