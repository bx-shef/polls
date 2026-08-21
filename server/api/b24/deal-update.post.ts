// POST /api/b24/deal-update — авто-триггер ONCRMDEALUPDATE (event.bind, #17; охват на ВСЕХ тарифах,
// дополняет робота bizproc). Недоверенный server-to-server POST портала. Bitrix шлёт online-события
// как `application/x-www-form-urlencoded` c bracket-нотацией (`data[FIELDS][ID]=759&auth[member_id]=…`) —
// h3 `readBody` отдаёт ПЛОСКИЙ объект, поэтому СНАЧАЛА `parseBracketForm` (→ вложенный `{data:{FIELDS:{ID}}}`),
// затем ядровой `runDealUpdate`: parseDealUpdateEvent → verifyApplicationToken (сохранённый app_token,
// constant-time — анти-форджери) → crm.deal.get ТОКЕНОМ ПОРТАЛА (домен из СОХРАНЁННОГО токена, не из
// события — SSRF) → dealToCrmContext → handleDealTrigger. ВСЕГДА 200 — кроме общего бэкстопа размера
// тела (`server/middleware/body-limit.ts`, 413/411): он стоит ДО маршрутизации, решает по одному
// заголовку и до хранилища не доходит, поэтому оракулом не служит. Легальному событию недостижимо.
// Внутри же обработчика — всегда 200: B24 online-события НЕ ретраит,
// форджери/ошибку/отсутствие конфига наружу не раскрываем (только лог). Доставка ссылки адресату — отдельный слой.
import { runDealUpdate } from '~core/bitrix24/deal-update'
import { parseBracketForm } from '~core/bitrix24/bracket-form'
import { Bitrix24OAuth } from '~core/bitrix24/oauth'
import { createPortalClient, dealGet, dealProductRows, frameToB24Params, stageHistoryList } from '~core/bitrix24/client'
import { createKeySerializer } from '~core/api/serial-by-key'
import {
  inspectStageEntry,
  resolveStageEntryWindowSec,
  STAGE_HISTORY_ENTITY_TYPE_ID
} from '~core/bitrix24/stage-transition'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { resolveTriggerMode, eventTriggerEnabled } from '~core/bitrix24/trigger-mode'
import { errInfo } from '~core/obs/logger'
import { usePortalTokenStore, b24AppConfig } from '../../utils/portal'
import { timeoutFetch } from '../../utils/b24-fetch'
import { logger } from '../../utils/api'
import { tenantByMemberId, type PortalTenant } from '../../utils/tenant'
import { makeInviteIssue } from '../../utils/invite-issue'

// Таймаут исходящего OAuth-рефреша (accessToken портала мог протухнуть) — общий `timeoutFetch`
// (server/utils/b24-fetch), как в install. Рефреш редок (keep-alive держит токен свежим), но защищаемся.

// Rate-limit публичного event-роута: до сверки токена каждый запрос делает SELECT (+ расшифровку blob).
// Без лимита — вектор DoS-амплификации неаутентифицированным флудом. Потолок высокий: ONCRMDEALUPDATE
// бьёт на ЛЮБОЙ апдейт сделки, у активного портала событий много — режем только флуд, не легитимный поток.
// In-memory, на инстанс (общий стор для мульти-инстанса — #4). Ключ — реальный адрес клиента
// (`requestIp` → `~core/api/client-ip`), а не адрес прокси: иначе весь портал считался бы одним.
const dealUpdateLimiter = new SlidingWindowLimiter({ limit: 600, windowMs: 60_000 })

/**
 * Очередь «поиск дела → создание» по ключу перехода — ОДНА на процесс (#138).
 *
 * ⚠️ Модульная, а не на запрос: смысл ровно в том, чтобы ДВА ОДНОВРЕМЕННЫХ события одного перехода
 * встали друг за другом. Заведи её внутри обработчика — у каждого события была бы своя, и очередь
 * перестала бы что-либо значить. Проверено на живом портале: два дела с одним `ORIGIN_ID` Bitrix24
 * создаёт спокойно, уникальность маркера — не его забота, а наша.
 */
const inviteSerializer = createKeySerializer()

export default defineEventHandler(async (event) => {
  // Режим триггера выключен для события → не обслуживаем. Штатный сценарий: режим сменили на `robot`,
  // а `event.bind` с прошлой установки остался (отписки нет — см. docs/process.md, шаг 1), и портал
  // продолжает слать события. Логируем, иначе это выглядит полной тишиной при живом потоке запросов.
  const mode = resolveTriggerMode(process.env.TRIGGER_MODE)
  if (!eventTriggerEnabled(mode)) {
    logger.debug('b24_deal_update_disabled', { mode })
    setResponseStatus(event, 200)
    return 'ok'
  }
  if (!dealUpdateLimiter.allow(requestIp(event), new Date())) {
    // B24 online-события не ретраит; наружу — «ok» (не раскрываем лимит), но в лог для диагностики.
    logger.warn('b24_deal_update_ratelimited', { msg: 'превышен лимит event-роута' })
    setResponseStatus(event, 200)
    return 'ok'
  }
  try {
    const body = await readBody(event).catch(() => ({}))
    // Разбор bracket-формы Bitrix (form-urlencoded) во вложенный объект; идемпотентно на JSON-теле.
    // ⚠️ ВНУТРИ `try` — как у робота. Инвариант роута «всегда 200»: бросок на разборе недоверенного
    // тела давал бы 500, а 500 против 200 — это оракул, по которому снаружи отличают «тело мы не
    // поняли» от «поняли и обработали».
    const raw = parseBracketForm((body && typeof body === 'object' ? body : {}) as Record<string, unknown>)
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
      fetch: timeoutFetch
    })

    // ⚠️ TENANT (#49): стор и приглашения выбираются ПО `member_id` события — и только после того, как
    // ядро сверило `application_token` (резолвер зовётся уже за проверкой, см. `runDealUpdate`). Раньше
    // стор был один на процесс, и стадия сделки одного заказчика выписывала бы приглашение в данные
    // другого. Мемоизация — по `member_id`: одно событие про один портал, но резолвер зовут и выписка
    // дела, и само ядро, а два независимых резолва разъехались бы молча.
    const tenants = new Map<string, Promise<PortalTenant | undefined>>()
    const tenantFor = (memberId: string) => {
      const cached = tenants.get(memberId)
      if (cached) return cached
      const p = tenantByMemberId(memberId)
      tenants.set(memberId, p)
      return p
    }

    // Клиент портала: токеном ПОРТАЛА (не события). Домен — из СОХРАНЁННОГО токена (валидирован
    // allowlist'ом на установке), не из недоверенного события (SSRF). ОДИН на обработку события
    // (мемоизация): иначе догрузка сделки и запрос истории строили бы клиента дважды — два чтения
    // токена с расшифровкой и, главное, два независимых лимитера SDK, не видящих суммарный темп.
    // Кэш — ПО `memberId`, а не один на запрос: tenant-изоляция — инвариант проекта, и держаться она
    // должна структурно, а не на комментарии «в запросе member_id всё равно один».
    const clients = new Map<string, Promise<ReturnType<typeof createPortalClient>>>()
    const portalClient = (memberId: string) => {
      const cached = clients.get(memberId)
      if (cached) return cached
      const p = (async () => {
        const tokens = await tokenStore.load(memberId)
        const accessToken = await tokenStore.accessToken(memberId, oauth)
        if (!tokens?.domain || !accessToken) throw new Error(`портал ${memberId}: токен/домен недоступен`)
        return createPortalClient(frameToB24Params({ domain: tokens.domain, accessToken, memberId }), cfg.secret)
      })()
      clients.set(memberId, p)
      return p
    }

    const outcome = await runDealUpdate(raw, {
      storedApplicationToken: async (memberId) => (await tokenStore.load(memberId))?.applicationToken,
      // Событие приходит на ЛЮБОЙ апдейт сделки, а отдельного события смены стадии в Bitrix24 нет —
      // подтверждаем реальный переход историей портала (`crm.stagehistory.list`). Ошибку гасим в false:
      // без доказательства перехода молчим (ложная рассылка клиентам дороже пропуска).
      confirmStageEntry: async (dealId, stageId, memberId) => {
        try {
          const records = await stageHistoryList(await portalClient(memberId), STAGE_HISTORY_ENTITY_TYPE_ID.deal, dealId)
          const seen = inspectStageEntry(records, {
            stageId,
            now: new Date(),
            windowSec: resolveStageEntryWindowSec(process.env.STAGE_ENTRY_WINDOW_SECONDS)
          })
          if (!seen.fresh) {
            // Пишем НАБЛЮДЁННОЕ: иначе системная поломка (рассинхрон формата стадии, уехавшие часы,
            // пустая история) выглядит в логе ровно как штатное «переход был давно».
            logger.info('b24_stage_entry_stale', {
              dealId,
              expectedStage: stageId,
              observedStage: seen.observedStageId ?? '(история пуста)',
              ageSec: seen.ageSec ?? null,
              records: records.length
            })
          } else {
            // ⚠️ `transitionId` в логе — не украшение, а ИЗМЕРЕНИЕ дублей перед их лечением (#138).
            // Вся гипотеза лечения стоит на том, что гроздь событий вокруг одного перехода видит в
            // истории ОДНУ И ТУ ЖЕ запись. На живом портале это надо не предположить, а увидеть:
            // несколько строк `b24_stage_entry_fresh` с одинаковым `transitionId` — гипотеза верна и
            // маркер сработает; разные `transitionId` — лечить надо иначе, и хорошо, что узнали до, а
            // не после того, как клиент получил несколько писем.
            logger.info('b24_stage_entry_fresh', {
              dealId,
              stageId,
              transitionId: seen.transitionId ?? '(ID не прочитан)',
              ageSec: seen.ageSec ?? null
            })
          }
          // `transitionId`/`transitionAt` едут дальше: первый становится ключом маркера, второй —
          // точкой отсчёта «ответил ли клиент после этого перехода». Оба — из ТОЙ ЖЕ записи, по
          // которой принято решение о свежести; пересчёт вторым запросом дал бы другую картину.
          return {
            fresh: seen.fresh,
            ...(seen.transitionId !== undefined ? { transitionId: seen.transitionId } : {}),
            ...(seen.transitionAt !== undefined ? { transitionAt: seen.transitionAt } : {})
          }
        } catch (e) {
          logger.warn('b24_stage_history_fail', { dealId, detail: (e as Error).message })
          return { fresh: false }
        }
      },
      fetchDeal: async (dealId, memberId) => {
        const client = await portalClient(memberId)
        const deal = await dealGet(client, dealId)
        // Товарные позиции best-effort (у сделки может не быть товаров / нет скоупа): без них срез
        // «услуга/товар» пуст. Ошибку глушим, но ЛОГИРУЕМ — иначе систематический провал незаметен.
        const productRows = await dealProductRows(client, dealId).catch((e: unknown) => {
          logger.warn('b24_deal_productrows_fail', { msg: `Сделка ${dealId}: ${(e as Error).message}` })
          return []
        })
        return { deal, productRows }
      },
      tenant: tenantFor,
      // Отказ по ОДНОМУ опросу не должен лишать приглашения остальные опросы этой же стадии: событие
      // Bitrix24 не ретраит, значит потерянный опрос теряется навсегда. Причина — сюда, поимённо.
      onIssueError: (surveyKey, e) =>
        // ⚠️ `errInfo`, а не `.message`: `redact` маскирует по ИМЕНИ ключа, `detail` секретным именем не
        // считается, а сюда доезжают ошибки `pg` (в тексте бывает строка подключения с паролем) и SDK.
        // `path` — имя события одно на оба пути триггера, иначе по логу не сказать, чей отказ.
        logger.warn('b24_invite_fail', { path: 'event', surveyKey, err: errInfo(e) }),
      // Выписка приглашения через дело в таймлайне (#126 + #138) — отдельным модулем: там она
      // исполняется тестами (гроздь → одно дело, отказ создания не оставляет живого токена, маркер
      // не виден поиску), а замыкание внутри роута проверить было нечем.
      issue: (ctx) => makeInviteIssue(ctx, {
        portalClient,
        // ⚠️ Тот же резолвер, что у ядра: выписка обязана писать в ТОТ ЖЕ портал, что и триггер.
        // Резолв на этом шаге уже сделан и лежит в кэше — второго обращения к БД тут нет.
        tenant: async () => {
          const t = await tenantFor(ctx.memberId)
          // Недостижимо на живом пути (ядро зовёт выписку только после успешного резолва), но
          // молчаливый фолбэк на общий стор здесь — это ровно тот дефект, который мы и убираем.
          if (!t) throw new Error(`портал ${ctx.memberId}: не найден`)
          return t
        },
        serializer: inviteSerializer,
        baseUrl: b24AppConfig()?.baseUrl ?? '',
        log: logger
      })
    })

    if (outcome.kind === 'ignored') {
      // Событие не распознано. ЛОГИРУЕМ ключи (не значения) — так дрейф wire-формата виден в проде.
      logger.warn('b24_deal_update_ignored', { msg: `не распознано (${outcome.reason}); ключи: ${Object.keys(raw).join(',')}` })
    } else if (outcome.kind === 'forged') {
      // Подделка / портал не установлен — наружу не раскрываем; в лог с заявленным member_id для сверки.
      logger.warn('b24_deal_update_reject', { reason: outcome.reason, memberId: outcome.memberId })
    } else if (outcome.kind === 'skipped') {
      // Штатная ветка: обычное редактирование сделки, давно стоящей в триггерной стадии. info, не warn.
      logger.info('b24_deal_update_skip', { dealId: outcome.dealId, stageId: outcome.stageId })
    } else {
      // `failed` отделён от `deduped` намеренно: «уже приглашали» — штатный исход, «не смогли» —
      // потерянный ответ клиента. Пока они шли одной строкой, эти два случая были неразличимы.
      const level = outcome.failed.length > 0 ? 'warn' : 'info'
      logger[level]('b24_deal_update', {
        msg: `создано приглашений: ${outcome.results.length}`,
        // Отсечённая гроздь. Ноль здесь и >0 создано — событие было первым; >0 здесь — дедуп работает.
        deduped: outcome.deduped.length,
        failed: outcome.failed.length
      })
    }
  } catch (e) {
    // Транзиент (REST/refresh/БД/холодный старт) — B24 online-события НЕ ретраит; лог для диагностики, ответ 200.
    logger.warn('b24_deal_update_fail', { msg: (e as Error).message })
  }

  setResponseStatus(event, 200)
  return 'ok'
})
