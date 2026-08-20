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
import {
  activityConfigurableAdd, activityListByMarker, buildSurveyInviteActivity, ensureActivityMarker
} from '~core/bitrix24/activity'
import { deliverInvite } from '~core/bitrix24/invite-delivery'
import { createKeySerializer } from '~core/api/serial-by-key'
import { surveyPath } from '~core/client/invitation-link'
import {
  inspectStageEntry,
  resolveStageEntryWindowSec,
  STAGE_HISTORY_ENTITY_TYPE_ID
} from '~core/bitrix24/stage-transition'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { resolveTriggerMode, eventTriggerEnabled } from '~core/bitrix24/trigger-mode'
import { usePortalTokenStore, b24AppConfig } from '../../utils/portal'
import { timeoutFetch } from '../../utils/b24-fetch'
import { useStore, useInvitations, logger } from '../../utils/api'

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
      fetch: timeoutFetch
    })

    // ⚠️ TENANT (#49): useStore()/useInvitations() — SINGLE-TENANT (один портал на инстанс приложения).
    // `member_id` события НЕ выбирает стор. Для мульти-портала ОБЯЗАТЕЛЕН scoped-стор по member_id, иначе
    // стадия одного портала триггернёт опрос данных другого (cross-tenant). Гейт — #49.
    const store = await useStore()

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
      store,
      invitations: useInvitations(),
      /**
       * Выписка приглашения через дело в таймлайне (#126 + #138). Правило («открыто → молчим; нет →
       * приглашаем; закрыто без ответа → зовём снова; закрыто и отвечено → молчим») живёт в ядре;
       * здесь только I/O к порталу и к своим ответам.
       *
       * ⚠️ Без ключа перехода дедупить нечем — тогда старое поведение: просто выписать приглашение.
       * Терять законный переход из-за нечитаемого `ID` в истории хуже, чем пропустить гроздь; исход
       * при этом виден в логе.
       */
      issue: ({ transition, memberId }) => async (args) => {
        const dealId = args.context.dealId
        if (transition.id === undefined || dealId === undefined) {
          logger.info('b24_invite_no_dedup', {
            surveyKey: args.surveyKey,
            reason: transition.id === undefined ? 'нет ID перехода' : 'нет сделки в контексте'
          })
          const inv = await useInvitations().create(
            { surveyKey: args.surveyKey, versionNo: args.versionNo, context: args.context, ttlMs: args.ttlMs },
            args.now
          )
          return { surveyKey: args.surveyKey, versionNo: args.versionNo, token: inv.token }
        }

        const client = await portalClient(memberId)
        let issued: { token: string } | undefined
        const out = await deliverInvite(transition.id, args.surveyKey, {
          serializer: inviteSerializer,
          findByMarker: (marker) => activityListByMarker(client, marker),
          // Точка отсчёта — момент ЭТОГО перехода: прошлогодний ответ не должен закрывать новый
          // повод спросить, если сделка прошла стадию второй раз.
          answeredAfterTransition: () =>
            store.hasResponseSince(args.surveyKey, dealId, transition.at ?? args.now),
          createInvite: async (marker) => {
            const inv = await useInvitations().create(
              { surveyKey: args.surveyKey, versionNo: args.versionNo, context: args.context, ttlMs: args.ttlMs },
              args.now
            )
            issued = { token: inv.token }
            const base = b24AppConfig()?.baseUrl ?? ''
            return activityConfigurableAdd(client, buildSurveyInviteActivity({
              dealId,
              surveyTitle: args.title,
              surveyKey: args.surveyKey,
              token: inv.token,
              surveyUrl: `${base}${surveyPath(args.surveyKey, inv.token)}`,
              ...(args.context.responsibleId != null ? { responsibleId: args.context.responsibleId } : {}),
              marker
            }))
          },
          ensureMarker: (activityId, marker) => ensureActivityMarker(client, activityId, marker)
        })

        if (out.kind === 'skipped') {
          logger.info('b24_invite_dedup', { surveyKey: args.surveyKey, dealId, reason: out.reason, marker: out.marker.originId })
          return undefined
        }
        // `markerFix` — ответ на единственный незакрытый вопрос: принял ли `configurable.add` поля
        // маркера. `repaired` значит «не принял, дописали» — увидим на первом же прогоне.
        logger.info('b24_invite_activity', {
          surveyKey: args.surveyKey, dealId, activityId: out.activityId, markerFix: out.markerFix
        })
        return issued ? { surveyKey: args.surveyKey, versionNo: args.versionNo, token: issued.token } : undefined
      }
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
      logger.info('b24_deal_update', {
        msg: `создано приглашений: ${outcome.results.length}`,
        // Отсечённая гроздь. Ноль здесь и >0 создано — событие было первым; >0 здесь — дедуп работает.
        deduped: outcome.deduped.length
      })
    }
  } catch (e) {
    // Транзиент (REST/refresh/БД/холодный старт) — B24 online-события НЕ ретраит; лог для диагностики, ответ 200.
    logger.warn('b24_deal_update_fail', { msg: (e as Error).message })
  }

  setResponseStatus(event, 200)
  return 'ok'
})
