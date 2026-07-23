import { Bitrix24OAuth } from '~core/bitrix24/oauth'
import { runKeepAlive, keepAliveIntervalMs } from '~core/bitrix24/keep-alive'
import { errInfo } from '~core/obs/logger'
import { usePortalTokenStore } from '../utils/portal'
import { logger } from '../utils/api'

/**
 * Nitro-плагин keep-alive (docs/project-map.md §2.4): периодический таймер рефрешит
 * OAuth-токены порталов у истечения `refresh_token` (~180 дней), иначе простаивающий портал
 * (никто не проходит опрос → нет REST-вызовов → ленивый рефреш не срабатывает) теряет токен.
 *
 * Логика прохода — в ядре (`runKeepAlive`, под тестами); здесь только живая обвязка:
 *  - гейт на OAuth-креды (`NUXT_B24_CLIENT_ID/SECRET`) — без них рефреш невозможен;
 *  - `usePortalTokenStore` (PgStore + шифр) — источник near-expiry порталов и персиста рефреша;
 *  - каденция `TOKEN_KEEPALIVE_HOURS` (клэмп [1ч,168ч]); `unref` — таймер не держит процесс;
 *  - НЕМЕДЛЕННЫЙ первый прогон (с малой задержкой): прод на авто-CD (merge→GHCR→watchtower)
 *    может рестартовать чаще каденции — тогда `setInterval` никогда не истёк бы (ревью CTO/программист).
 * Замечание: keep-alive впервые создаёт (маловероятную) гонку рефреша с живым REST-путём даже на
 * ОДНОМ инстансе — закрывается advisory-lock'ом (improvement-plan §2.5, вместе с мульти-инстансом #4).
 * SERVER-ONLY: `~core/bitrix24`/`~core/obs` импортируются намеренно (Nitro-контур, не в клиентский бандл).
 */
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const clientId = process.env.NUXT_B24_CLIENT_ID
  const clientSecret = process.env.NUXT_B24_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    logger.info('keepalive_off', { reason: 'нет NUXT_B24_CLIENT_ID/SECRET' })
    return
  }

  const intervalMs = keepAliveIntervalMs(process.env.TOKEN_KEEPALIVE_HOURS)
  const oauth = new Bitrix24OAuth({ clientId, clientSecret })

  const tick = async (): Promise<void> => {
    const store = await usePortalTokenStore()
    if (!store) {
      // Креды заданы, но нет БД/ключа шифрования — keep-alive работать не может. Видимый сигнал,
      // иначе `keepalive_on` даёт ложное чувство защиты (ревью-программист).
      logger.warn('keepalive_no_store', { reason: 'нет DATABASE_URL/NUXT_BITRIX_TOKEN_KEY' })
      return
    }
    await runKeepAlive({
      listNearExpiry: () => store.listNearExpiry(),
      // access-токен near-expiry портала давно протух → accessToken рефрешит, ротируя refresh_token.
      refreshOne: async (memberId) => {
        await store.accessToken(memberId, oauth)
      },
      logger
    })
  }

  const run = (): void => {
    tick().catch((e) => logger.warn('keepalive_tick_fail', { reason: errInfo(e).message }))
  }

  // Первый прогон с малой задержкой (дать БД подняться на старте), затем — по каденции.
  const initial = setTimeout(run, 15_000)
  initial.unref()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  nitroApp.hooks.hook('close', () => {
    clearTimeout(initial)
    clearInterval(timer)
  })
  logger.info('keepalive_on', { intervalHours: intervalMs / 3_600_000 })
})
