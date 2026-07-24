// POST /api/b24/deal-update — авто-триггер ONCRMDEALUPDATE (event.bind, #17; охват на ВСЕХ тарифах,
// дополняет робота bizproc). Недоверенный server-to-server POST портала. Bitrix шлёт online-события
// как `application/x-www-form-urlencoded` c bracket-нотацией (`data[FIELDS][ID]=759&auth[member_id]=…`) —
// h3 `readBody` отдаёт ПЛОСКИЙ объект, поэтому СНАЧАЛА `parseBracketForm` (→ вложенный `{data:{FIELDS:{ID}}}`),
// затем ядровой `runDealUpdate`: parseDealUpdateEvent → verifyApplicationToken (сохранённый app_token,
// constant-time — анти-форджери) → crm.deal.get ТОКЕНОМ ПОРТАЛА (домен из СОХРАНЁННОГО токена, не из
// события — SSRF) → dealToCrmContext → handleDealTrigger. ВСЕГДА 200: B24 online-события НЕ ретраит,
// форджери/ошибку/отсутствие конфига наружу не раскрываем (только лог). Доставка ссылки адресату — отдельный слой.
import { runDealUpdate } from '~core/bitrix24/deal-update'
import { parseBracketForm } from '~core/bitrix24/bracket-form'
import { Bitrix24OAuth, type HttpFetch, type HttpResponse } from '~core/bitrix24/oauth'
import { createPortalClient, dealGet, dealProductRows, frameToB24Params } from '~core/bitrix24/client'
import { usePortalTokenStore, b24AppConfig } from '../../utils/portal'
import { useStore, useInvitations, logger } from '../../utils/api'

// Таймаут исходящего OAuth-рефреша (accessToken портала мог протухнуть) — как в install.post.ts:
// без лимита зависший oauth.bitrix.info держал бы соединение до дефолта undici. Рефреш редок
// (keep-alive держит токен свежим), но защищаемся.
const OAUTH_REFRESH_TIMEOUT_MS = 10_000
const timeoutRefreshFetch: HttpFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS) }) as Promise<HttpResponse>

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  // Разбор bracket-формы Bitrix (form-urlencoded) во вложенный объект; идемпотентно на JSON-теле.
  const raw = parseBracketForm((body && typeof body === 'object' ? body : {}) as Record<string, unknown>)

  try {
    // Инициализация стора/конфига — ВНУТРИ try: `useStore()` может реджектнуть на холодном старте с
    // недоступной БД. Инвариант «всегда 200» держим и на этом (B24 online-события не ретраит; наружу — «ok»).
    const cfg = b24AppConfig()
    const tokenStore = await usePortalTokenStore()
    if (!cfg || !tokenStore) {
      // Мисконфиг (нет OAuth-креды/БД/ключа) — наружу не раскрываем, но ЛОГИРУЕМ: иначе тихий no-op незаметен.
      logger.warn('b24_deal_update_no_config', { msg: 'интеграция не сконфигурирована (cfg/tokenStore)' })
      setResponseStatus(event, 200)
      return 'ok'
    }

    const oauth = new Bitrix24OAuth({
      clientId: cfg.secret.clientId,
      clientSecret: cfg.secret.clientSecret,
      fetch: timeoutRefreshFetch
    })

    // ⚠️ TENANT (#49): useStore()/useInvitations() — SINGLE-TENANT (один портал на инстанс приложения).
    // `member_id` события НЕ выбирает стор. Для мульти-портала ОБЯЗАТЕЛЕН scoped-стор по member_id, иначе
    // стадия одного портала триггернёт опрос данных другого (cross-tenant). Гейт — #49.
    const store = await useStore()
    const outcome = await runDealUpdate(raw, {
      storedApplicationToken: async (memberId) => (await tokenStore.load(memberId))?.applicationToken,
      fetchDeal: async (dealId, memberId) => {
        // Токеном ПОРТАЛА (не события): accessToken авто-рефрешит и сверяет member_id. Домен — из
        // СОХРАНЁННОГО токена (валидирован allowlist'ом на установке), не из недоверенного события (SSRF).
        const tokens = await tokenStore.load(memberId)
        const accessToken = await tokenStore.accessToken(memberId, oauth)
        if (!tokens?.domain || !accessToken) throw new Error(`портал ${memberId}: токен/домен недоступен`)
        const client = createPortalClient(
          frameToB24Params({ domain: tokens.domain, accessToken, memberId }),
          cfg.secret
        )
        const deal = await dealGet(client, dealId)
        // Товарные позиции best-effort (у сделки может не быть товаров / нет скоупа): без них срез
        // «услуга/товар» пуст. Ошибку глушим, но ЛОГИРУЕМ — иначе систематический провал незаметен.
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
      // Событие не распознано. ЛОГИРУЕМ ключи (не значения) — так дрейф wire-формата виден в проде.
      logger.warn('b24_deal_update_ignored', { msg: `не распознано (${outcome.reason}); ключи: ${Object.keys(raw).join(',')}` })
    } else if (outcome.kind === 'forged') {
      // Подделка / портал не установлен — наружу не раскрываем; в лог с заявленным member_id для сверки.
      logger.warn('b24_deal_update_reject', { reason: outcome.reason, memberId: outcome.memberId })
    } else {
      logger.info('b24_deal_update', { msg: `создано приглашений: ${outcome.results.length}` })
    }
  } catch (e) {
    // Транзиент (REST/refresh/БД/холодный старт) — B24 online-события НЕ ретраит; лог для диагностики, ответ 200.
    logger.warn('b24_deal_update_fail', { msg: (e as Error).message })
  }

  setResponseStatus(event, 200)
  return 'ok'
})
