// Закрытие дела-приглашения при получении ответа (#177) — Nitro-слой: ядро про REST не знает.
//
// Зачем это вообще. Дело в таймлайне сделки — призыв к действию «Отправить приглашение», и до сих
// пор его никто не закрывал: `COMPLETED: Y` не ставился нигде. Два следствия, и оба заметны.
//  1. **Продуктовое.** В карточке сделки навсегда висела незакрытая задача — в том числе после того,
//     как клиент уже ответил. Менеджер видит вечный таск, служба качества — растущий список
//     фантомных дел, и доверие к блоку падает быстрее, чем приезжает остальная часть #18.
//  2. **Инженерное.** Две нижние строки правила «уже приглашали?» («дело закрыто, ответа нет» и
//     «дело закрыто, ответ есть») были НЕДОСТИЖИМЫ: открытое дело перевешивает всё, поэтому на любой
//     повторный переход правило отвечало «ждём клиента» — даже когда клиент давно ответил.
//
// ⚠️ Работа с зависимостями НАРУЖУ (`closeInvite(info, deps)`), а не резолвится внутри — тем же
// приёмом и по той же причине, что `invite-issue.ts`: пока всё резолвилось само, модуль нельзя было
// исполнить в тесте вовсе, а внутри него пять ранних выходов, каждый из которых полностью выключает
// фичу. Тонкая сборка боевых зависимостей — в самом низу файла.
import { Bitrix24OAuth } from '~core/bitrix24/oauth'
import { createPortalClient, frameToB24Params, type PortalClient } from '~core/bitrix24/client'
import { completeActivity, openInviteActivities } from '~core/bitrix24/activity'
import { memberIdByPortalId } from '~core/bitrix24/portal'
import type { AnsweredInfo } from '~core/api/handlers'
import { errInfo } from '~core/obs/logger'
import { createKeySerializer } from '~core/api/serial-by-key'
import { usePortalDb, usePortalId, logger } from './api'
import { usePortalTokenStore, b24AppConfig } from './portal'
import { timeoutFetch } from './b24-fetch'

/**
 * Дедлайн на всю работу с порталом, мс.
 *
 * ⚠️ Не перестраховка. Хук ждут ДО отдачи 200, а внутри — возможный рефреш токена (до 10 с) плюс
 * список и обновления через SDK: у него свой таймаут 30 с, до трёх ретраев и backoff, то есть один
 * вызов может тянуться минуты. Человек, уже заполнивший анкету, всё это время висит на «Отправить»:
 * прокси режет по своему таймауту, он видит «не отправилось» по УЖЕ записанному ответу, жмёт снова и
 * получает «опрос пройден». Ответ спасён, впечатление — нет, и это самый видимый клиенту экран.
 */
export const CLOSE_DEADLINE_MS = 3000

/** Сколько дел закрываем за один ответ. Больше — признак поломки, а не нормальной нагрузки. */
export const MAX_CLOSE_PER_ANSWER = 10

/** Что нужно закрытию, кроме самого ответа. Всё внедряется — модуль ничего не резолвит сам. */
export interface CloseInviteDeps {
  /** Клиент портала, обслуживающего этот инстанс; `undefined` — портала нет (не установлен/память). */
  portalClient: () => Promise<PortalClient | undefined>
  log: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
  }
  /** Дедлайн (тесты подменяют, чтобы не ждать). */
  deadlineMs?: number
  /** Отказ работы — сбросить кэш клиента: протухший грант иначе завис бы до рестарта. */
  onFailure?: () => void
}

/** Гонка «работа против дедлайна»: истёк — отпускаем ответ, работа доигрывает в фоне. */
async function withDeadline(work: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
  try {
    if ((await Promise.race([work.then(() => 'done' as const), deadline])) === 'timeout') onTimeout()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Закрыть открытые дела-приглашения по сделке и опросу из ответа.
 *
 * ⚠️ Best-effort по построению: **ответ клиента дороже отметки в таймлайне**. Всё, чего может не
 * быть (портала нет, сделки нет в снимке), — штатный выход без шума; отказ портала логируется, но
 * наружу не идёт. Заставить человека заполнять анкету заново из-за недоступности CRM — худшее, что
 * тут можно сделать.
 *
 * ⚠️ Дел может быть НЕСКОЛЬКО: сделка может пройти триггерную стадию не один раз, и на каждый заход
 * выписывается своё приглашение. Ответ закрывает вопрос по опросу целиком, поэтому закрываем все
 * найденные — иначе оставшееся дело так и висело бы призывом отправить ссылку ответившему клиенту.
 */
export async function closeInvite(info: AnsweredInfo, deps: CloseInviteDeps): Promise<void> {
  const dealId = info.context.dealId
  // ⚠️ Проверяем ФОРМУ, а не только наличие. `crmContextSchema.dealId` — просто `z.number().optional()`,
  // а значение попадает в фильтр `OWNER_ID`: если портал проигнорирует `0`/`null` как ключ фильтра
  // (вживую не сверено), выборкой станут ВСЕ открытые дела приложения, и закрылись бы дела по чужим
  // сделкам. Сегодня недостижимо, но держаться на инварианте чужого модуля тут слишком дорого.
  if (dealId === undefined || !Number.isInteger(dealId) || dealId <= 0) return

  const work = (async (): Promise<void> => {
    const client = await deps.portalClient()
    if (!client) return // приложение не установлено / режим памяти — сервис работает сам по себе

    const found = await openInviteActivities(client, dealId, info.surveyKey)
    // ⚠️ Кап на работу внутри запроса. Дел на сделке единицы; десятки означают поломку (маркер не
    // проставился, и каждый переход плодил новое дело). Без капа один ответ покупал бы себе десятки
    // последовательных REST-вызовов — у SDK свой таймаут и ретраи, это минуты работы воркера.
    const ids = found.slice(0, MAX_CLOSE_PER_ANSWER)
    let closed = 0
    let failed = 0
    // ⚠️ Ошибка на одном деле не должна съедать остальные: дел на сделке может быть несколько, и
    // «первое упало — второе даже не пробовали» превращает частичный успех в полный отказ.
    for (const id of ids) {
      try { await completeActivity(client, id); closed++ } catch { failed++ }
    }
    // ⚠️ ПЕРЕЧИТЫВАЕМ, а не верим вызову — ровно как `ensureActivityMarker` с маркером. Дело создано
    // `crm.activity.configurable.add` (метод недоступен даже вебхуку), и поддержка `COMPLETED` через
    // `crm.activity.update` для настраиваемого дела — непроверенная ставка: портал может принять
    // update и ничего не изменить. Без сверки лог рапортовал бы `closed: 3` при трёх висящих делах,
    // и провал был бы НЕОТЛИЧИМ от работы.
    const stillOpen = closed > 0
      ? (await openInviteActivities(client, dealId, info.surveyKey).catch(() => [])).length
      : ids.length
    // ⚠️ `found` отделён от `closed` НАМЕРЕННО. `dealId` в снимке бывает только у приглашения из
    // событийного пути, а там дело создаётся вместе с приглашением — значит `found: 0` это не «дел не
    // было», а «мы своих дел не видим». И это ровно тот непроверенный риск, что и `markerVisible: no`
    // (#138): `crm.activity.list` может не возвращать настраиваемые дела. Тогда молчит не только
    // закрытие — ломается вся защита от дублей. Поэтому такой исход пишем как warn, а не info.
    const level = found.length === 0 || failed > 0 || stillOpen > 0 ? 'warn' : 'info'
    deps.log[level]('b24_invite_closed', {
      surveyKey: info.surveyKey,
      dealId,
      found: found.length,
      closed,
      failed,
      ...(found.length > ids.length ? { capped: MAX_CLOSE_PER_ANSWER } : {}),
      // Осталось открытым ПОСЛЕ закрытия: >0 значит, что портал принял update и ничего не сделал.
      stillOpen,

    })
  })().catch((e: unknown) => {
    deps.onFailure?.()
    // Отметка не поставлена — дело останется висеть, и правило «уже приглашали?» на следующем
    // переходе ответит «ждём клиента». Неприятно, но ответ записан, а это главное.
    // ⚠️ Ловим ЗДЕСЬ, а не снаружи `withDeadline`: после истечения дедлайна работа доигрывает уже без
    // ожидающего, и её отказ иначе всплыл бы unhandled rejection после завершения запроса.
    // ⚠️ `errInfo`, а не `.message`: `scrubSecrets` живёт именно в нём, а в тексте ошибки драйвера
    // pg бывает строка подключения с паролем, а в ошибке стора токенов — `member_id`. Строку тут
    // инициирует НЕАВТОРИЗОВАННЫЙ запрос, так что редакция обязательна.
    deps.log.warn('b24_invite_close_fail', { surveyKey: info.surveyKey, dealId, err: errInfo(e) })
  })

  await withDeadline(work, deps.deadlineMs ?? CLOSE_DEADLINE_MS, () => {
    // Ответ клиенту отпускаем, работа доигрывает в фоне и допишет свой исход сама.
    deps.log.warn('b24_invite_close_timeout', {
      surveyKey: info.surveyKey, dealId, afterMs: deps.deadlineMs ?? CLOSE_DEADLINE_MS
    })
  })
}

/**
 * Один клиент портала на процесс, с коротким TTL.
 *
 * ⚠️ Не микрооптимизация. У SDK лимитер (leaky-bucket) живёт ВНУТРИ клиента: собирая новый на каждый
 * ответ, мы получаем независимые бакеты — при массовой рассылке пик одновременных ответов суммарно
 * перебивает лимит портала, а на `QUERY_LIMIT_EXCEEDED` SDK ещё и ретраит. Страдает не только наше
 * закрытие, но и общая REST-квота портала, включая событийную доставку приглашений.
 *
 * TTL короткий, потому что refresh-токен могут ротануть рядом (keep-alive-крон, событийный путь);
 * ошибка клиента его тоже сбрасывает — иначе протухший грант завис бы до рестарта.
 */
const CLIENT_TTL_MS = 60_000
/**
 * Кэш — ПО ПОРТАЛУ (#49), а не один на процесс.
 *
 * ⚠️ Одна переменная на все порталы была бы не «лишним рефрешем», а закрытием дела чужим клиентом:
 * ответ портала B попал бы в клиент портала A, если тот лежит в кэше свежим. Ключ `undefined`
 * (режим памяти / портал по умолчанию) держим отдельной строкой того же кэша.
 */
const cachedByPortal = new Map<number | 'default', { at: number; client: PortalClient }>()

/**
 * Очередь по порталу — ОДНА на процесс.
 *
 * ⚠️ `PortalTokenStore.accessToken` рефрешит токен БЕЗ advisory-lock (известное ограничение). Раньше
 * этот путь дёргали keep-alive-крон и верифицированные события; теперь момент срабатывания задаёт
 * ВНЕШНИЙ неаутентифицированный трафик, и «после часового окна пришла пачка ответов» — обычная
 * ситуация рассылки. N параллельных рефрешей ротируют refresh-токен наперегонки, и «последний
 * записал» может сохранить уже отозванный грант: портал потеряет авторизацию до переустановки.
 */
const portalQueue = createKeySerializer()

/**
 * Боевые зависимости. Тонкий резолвер: всё, что тут есть, — сборка клиента портала.
 *
 * ⚠️ Портал берём ПО ТОМУ ЖЕ `portal.id`, под которым пишет стор. Отдельное правило («первый
 * установленный») разъезжалось бы с первым молча: удалили тестовый портал без очистки → строка
 * осталась → поставили боевой → ответы легли в один портал, а закрытие пошло бы в другой, с
 * отозванными токенами, и каждый ответ писал бы `close_fail`.
 */
export function liveCloseDeps(forPortalId?: number): CloseInviteDeps {
  const cacheKey: number | 'default' = forPortalId ?? 'default'
  return {
    log: logger,
    onFailure: () => { cachedByPortal.delete(cacheKey) },
    // ⚠️ Ключ очереди — ПОРТАЛ. Общий ключ выстроил бы ответы разных заказчиков в одну цепочку:
    // медленный рефреш одного портала держал бы закрытие дел всех остальных.
    portalClient: () => portalQueue.run(`close-invite:${cacheKey}`, async () => {
      const cached = cachedByPortal.get(cacheKey)
      if (cached && Date.now() - cached.at < CLIENT_TTL_MS) return cached.client
      const db = await usePortalDb()
      // Портал ответа приходит параметром (его знает `useApiFor`, собирая хук). `undefined` — режим
      // памяти либо портал по умолчанию: тогда спрашиваем процессный, как было до мультитенанта.
      const portalId = forPortalId ?? await usePortalId()
      const cfg = b24AppConfig()
      const tokenStore = await usePortalTokenStore()
      if (!db || portalId === undefined || !cfg || !tokenStore) return undefined
      const memberId = await memberIdByPortalId(db, portalId)
      if (!memberId) return undefined // плейсхолдер: приложение ещё не установлено
      const oauth = new Bitrix24OAuth({
        clientId: cfg.secret.clientId,
        clientSecret: cfg.secret.clientSecret,
        fetch: timeoutFetch
      })
      const tokens = await tokenStore.load(memberId)
      const accessToken = await tokenStore.accessToken(memberId, oauth)
      if (!tokens?.domain || !accessToken) {
        // Портал установлен, а токен не расшифровался / не обновился — это ОТКАЗ, а не «нечего
        // делать»: без строки отсутствие результата на прогоне прочтут как «код не звался».
        logger.warn('b24_invite_close_skip', { reason: 'нет токена или домена портала' })
        return undefined
      }
      const client = createPortalClient(
        frameToB24Params({ domain: tokens.domain, accessToken, memberId }),
        cfg.secret
      )
      cachedByPortal.set(cacheKey, { at: Date.now(), client })
      return client
    })
  }
}

/**
 * Сбросить кэшированные клиенты порталов — ВСЕ.
 *
 * Зовётся на удалении приложения, рядом с `resetStoreCache()` и по той же причине: клиент живёт до
 * минуты, и без сброса удалённый портал ещё это время получал бы вызовы по уже отозванному гранту.
 * Отказ одного вызова кэш чистит сам (`onFailure`) — это про случай, когда вызова просто не будет.
 */
export function dropCachedPortalClients(): void {
  cachedByPortal.clear()
}
