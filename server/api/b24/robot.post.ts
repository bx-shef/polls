// POST /api/b24/robot — робот автоматизации «Запустить опрос» (#122). Второй путь триггера рядом с
// event.bind: робот встаёт в автоматизацию СТАДИИ и вызывается ровно НА ВХОДЕ в неё, поэтому здесь НЕ
// нужна проверка истории стадий (в отличие от /api/b24/deal-update, куда событие приходит на любой апдейт).
// Взамен робот доступен не на всех тарифах — какой путь использовать, выбирает оператор.
// Формат тела — как у событий: form-urlencoded с bracket-нотацией (`document_id[0]=crm&auth[member_id]=…`),
// поэтому сначала parseBracketForm, затем ядровой runRobotTrigger: parseRobotEvent → dealIdFromDocumentId →
// verifyApplicationToken (constant-time) → crm.deal.get ТОКЕНОМ ПОРТАЛА → handleDealTrigger.
// ВСЕГДА 200: bizproc повторов не гарантирует, а форджери/мисконфиг наружу не раскрываем (только лог).
// ⚠️ Единственное исключение — общий бэкстоп размера тела (`server/middleware/body-limit.ts`, 413/411):
// он стоит ДО маршрутизации, решает по одному заголовку и до хранилища не доходит, поэтому оракулом
// «установлен ли портал» не служит. Легальному bizproc-вызову недостижимо (тело — единицы килобайт).
import { runRobotTrigger } from '~core/bitrix24/robot'
import { parseBracketForm } from '~core/bitrix24/bracket-form'
import { Bitrix24OAuth } from '~core/bitrix24/oauth'
import { createPortalClient, dealGet, dealProductRows, frameToB24Params } from '~core/bitrix24/client'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { resolveTriggerMode, robotTriggerEnabled } from '~core/bitrix24/trigger-mode'
import { createKeySerializer } from '~core/api/serial-by-key'
import { errInfo } from '~core/obs/logger'
import { usePortalTokenStore, b24AppConfig } from '../../utils/portal'
import { makeInviteIssue } from '../../utils/invite-issue'
import { timeoutFetch } from '../../utils/b24-fetch'
import { logger } from '../../utils/api'
import { tenantByMemberId, type PortalTenant } from '../../utils/tenant'

// Публичный роут: до сверки токена каждый запрос делает SELECT (+ расшифровку blob) — режем флуд.
// Потолок ниже, чем у deal-update: робот срабатывает на переходах стадий, а не на каждом апдейте.
const robotLimiter = new SlidingWindowLimiter({ limit: 120, windowMs: 60_000 })

/**
 * Очередь «поиск дела → создание» по ключу перехода — ОДНА на процесс (как в событийном пути).
 *
 * ⚠️ Роботу дедуп не нужен (он срабатывает раз на переход), но очередь тут не про дедуп, а про
 * атомарность пары «нашли → создали»: bizproc может повторить вызов, и тогда два одновременных
 * прохода создали бы два дела. Bitrix24 уникальность `ORIGIN_ID` не форсит — проверено вживую.
 */
const inviteSerializer = createKeySerializer()

export default defineEventHandler(async (event) => {
  // Режим триггера выключен для робота → не обслуживаем, даже если регистрация осталась с прошлой
  // установки. Иначе при включённом событии один переход дал бы ДВА приглашения.
  const mode = resolveTriggerMode(process.env.TRIGGER_MODE)
  if (!robotTriggerEnabled(mode)) {
    logger.debug('b24_robot_disabled', { mode })
    setResponseStatus(event, 200)
    return 'ok'
  }
  if (!robotLimiter.allow(requestIp(event), new Date())) {
    logger.warn('b24_robot_ratelimited', { detail: 'превышен лимит роут-робота' })
    setResponseStatus(event, 200)
    return 'ok'
  }

  try {
    // Разбор тела — ВНУТРИ try: иначе неожиданный throw дал бы 500 вместо инварианта «всегда 200»
    // (и отличимый от нормы ответ анонимному вызывающему).
    const body = await readBody(event).catch(() => ({}))
    const raw = parseBracketForm((body && typeof body === 'object' ? body : {}) as Record<string, unknown>)

    const cfg = b24AppConfig()
    const tokenStore = await usePortalTokenStore()
    if (!cfg || !tokenStore) {
      logger.warn('b24_robot_no_config', { detail: 'интеграция не сконфигурирована (cfg/tokenStore)' })
      setResponseStatus(event, 200)
      return 'ok'
    }

    const oauth = new Bitrix24OAuth({
      clientId: cfg.secret.clientId,
      clientSecret: cfg.secret.clientSecret,
      fetch: timeoutFetch
    })

    // Клиент портала — ОДИН на обработку вызова (мемоизация по `member_id`), как в событийном пути:
    // иначе догрузка сделки и создание дела строили бы его дважды — два чтения токена с расшифровкой
    // и два независимых лимитера SDK, не видящих суммарный темп. Кэш ПО `memberId`, а не один на
    // запрос: tenant-изоляция держится структурно, а не комментарием «в вызове он всё равно один».
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

    // ⚠️ TENANT (#49) резолвится ОДИН раз на `member_id` и достаётся и ядру, и выписке: два
    // независимых резолва разъехались бы молча, а выписка ушла бы в другой портал, чем триггер.
    const tenants = new Map<string, Promise<PortalTenant | undefined>>()
    const tenantFor = (memberId: string) => {
      const cached = tenants.get(memberId)
      if (cached) return cached
      const p = tenantByMemberId(memberId)
      tenants.set(memberId, p)
      return p
    }

    const outcome = await runRobotTrigger(raw, {
      storedApplicationToken: async (memberId) => (await tokenStore.load(memberId))?.applicationToken,
      fetchDeal: async (dealId, memberId) => {
        const client = await portalClient(memberId)
        const deal = await dealGet(client, dealId)
        const productRows = await dealProductRows(client, dealId).catch((e: unknown) => {
          logger.warn('b24_deal_productrows_fail', { msg: `Сделка ${dealId}: ${(e as Error).message}` })
          return []
        })
        return { deal, productRows }
      },
      // ⚠️ TENANT (#49): стор и приглашения — по `member_id` события, и резолвер зовётся уже ЗА
      // сверкой `application_token` (см. `runRobotTrigger`). Раньше стор был один на процесс, и робот
      // одного заказчика выписывал бы приглашение в данные другого.
      tenant: tenantFor,
      // ⚠️ ДОСТАВКА (#175). До этого робот выписывал токен и всё: ссылка появлялась в базе и никуда
      // не уходила — сотрудник её не видел. Теперь выписка ТА ЖЕ, что у событийного пути: то же дело
      // в таймлайне, тот же маркер, то же закрытие ответом клиента. Отличается только ключ перехода
      // (`robotTransition`): истории стадий робот не спрашивает.
      issue: (ctx) => makeInviteIssue(ctx, {
        portalClient,
        tenant: async () => {
          const t = await tenantFor(ctx.memberId)
          // Недостижимо на живом пути (ядро зовёт выписку только после успешного резолва), но
          // молчаливый фолбэк на общий стор здесь — ровно тот дефект, который убрал #49.
          if (!t) throw new Error(`портал ${ctx.memberId}: не найден`)
          return t
        },
        serializer: inviteSerializer,
        baseUrl: cfg.baseUrl,
        log: logger
      }),
      // Отказ по ОДНОМУ опросу не должен лишать приглашения остальные опросы этой же стадии.
      // ⚠️ `errInfo`, а не `.message`: `redact` маскирует по ИМЕНИ ключа, а `detail` секретным именем
      // не считается — сырой текст ошибки уехал бы в лог как есть. Сюда доезжают ошибки `pg`
      // (в тексте бывает строка подключения с паролем) и SDK; `scrubSecrets` живёт именно в `errInfo`.
      // ⚠️ `path` — потому что имя события одно на оба пути: без него по логу не сказать, чей отказ.
      onIssueError: (surveyKey, e) =>
        logger.warn('b24_invite_fail', { path: 'robot', surveyKey, err: errInfo(e) })
    })

    if (outcome.kind === 'ignored') {
      // Логируем КЛЮЧИ (не значения) — так дрейф wire-формата робота виден в проде.
      logger.warn('b24_robot_ignored', { reason: outcome.reason, keys: Object.keys(raw).join(',') })
    } else if (outcome.kind === 'forged') {
      logger.warn('b24_robot_reject', { reason: outcome.reason, memberId: outcome.memberId })
    } else {
      // ⚠️ Три числа, а не одно: `invitations: 0` одинаково означало «стадия не триггерит опросов»,
      // «дедуп отсёк» и «выписка отвалилась» — событийный путь эти исходы разводит с #138.
      // ⚠️ `keys` печатаются и на УСПЕШНОЙ ветке, не только на отбракованной: единственный вопрос,
      // ради которого затевается живой прогон робота (#122), — что вообще приезжает в теле. Значения
      // не логируем никогда, только имена полей.
      // ⚠️ `tsSource`/`tsReason` показывают, взят ли ключ перехода из `ts` портала или с наших часов.
      // Второе означает, что дедупа у робота нет вовсе (ключ меняется каждую секунду), и без этой
      // строки такое состояние НЕВИДИМО.
      const level = outcome.failed.length > 0 ? 'warn' : 'info'
      logger[level]('b24_robot', {
        dealId: outcome.dealId,
        invitations: outcome.results.length,
        deduped: outcome.deduped.length,
        failed: outcome.failed.length,
        transitionId: outcome.transition.id,
        tsSource: outcome.transition.source,
        ...(outcome.transition.reason ? { tsReason: outcome.transition.reason } : {}),
        keys: Object.keys(raw).join(',')
      })
    }
  } catch (e) {
    logger.warn('b24_robot_fail', { detail: (e as Error).message })
  }

  setResponseStatus(event, 200)
  return 'ok'
})
