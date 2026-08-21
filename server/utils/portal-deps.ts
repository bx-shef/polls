// Клиент портала для побочных действий после записи ответа — один на портал, с коротким TTL (#177, #18).
//
// ⚠️ Отдельным модулем, а не внутри закрытия дела: действий стало ДВА (закрыть дело-приглашение и
// положить результат в таймлайн), и оба идут в один и тот же портал на один и тот же ответ. Пока
// сборка звалась `liveCloseDeps` и жила в модуле закрытия, второе действие пользовалось ею «по
// совпадению формы» — то есть имя врало, а расхождение двух копий было вопросом времени.
import { Bitrix24OAuth } from '~core/bitrix24/oauth'
import { createPortalClient, frameToB24Params, type PortalClient } from '~core/bitrix24/client'
import { memberIdByPortalId } from '~core/bitrix24/portal'
import { createKeySerializer } from '~core/api/serial-by-key'
import { usePortalDb, usePortalId, logger } from './api'
import { usePortalTokenStore, b24AppConfig } from './portal'
import { timeoutFetch } from './b24-fetch'

/** Общая часть зависимостей обоих побочных действий: клиент портала, лог, дедлайн, сброс кэша. */
export interface PortalActionDeps {
  /** Клиент портала, в CRM которого лёг ответ; `undefined` — портала нет (не установлен/память). */
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
export function livePortalDeps(forPortalId?: number): PortalActionDeps {
  // ⚠️ Ключ кэша — РЕЗОЛЬВНУТЫЙ портал, а не аргумент. Считая его до резолва, мы получали бы две
  // записи на один портал (`livePortalDeps(5)` и `livePortalDeps()` при процессном портале 5), то есть
  // два независимых leaky-bucket'а SDK — ровно то, против чего кэш и заведён.
  let cacheKey: number | 'default' = forPortalId ?? 'default'
  return {
    log: logger,
    onFailure: () => { cachedByPortal.delete(cacheKey) },
    // ⚠️ Ключ очереди — ПОРТАЛ. Общий ключ выстроил бы ответы разных заказчиков в одну цепочку:
    // медленный рефреш одного портала держал бы закрытие дел всех остальных.
    portalClient: () => portalQueue.run(`close-invite:${forPortalId ?? 'default'}`, async () => {
      const db = await usePortalDb()
      // Портал ответа приходит параметром (его знает `useApiFor`, собирая хук). `undefined` — режим
      // памяти либо портал по умолчанию: тогда спрашиваем процессный, как было до мультитенанта.
      const portalId = forPortalId ?? await usePortalId()
      if (portalId !== undefined) cacheKey = portalId
      const cached = cachedByPortal.get(cacheKey)
      if (cached && Date.now() - cached.at < CLIENT_TTL_MS) return cached.client
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
