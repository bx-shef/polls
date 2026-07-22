import { Bitrix24OAuth } from '~core/bitrix24/oauth'
import { runKeepAlive, keepAliveIntervalMs } from '~core/bitrix24/keep-alive'
import { usePortalTokenStore } from '../utils/portal'
import { logger } from '../utils/api'

/**
 * Nitro-плагин keep-alive (docs/improvement-plan.md §2.4): периодический таймер рефрешит
 * OAuth-токены порталов у истечения `refresh_token` (~180 дней), иначе простаивающий портал
 * (никто не проходит опрос → нет REST-вызовов → ленивый рефреш не срабатывает) теряет токен.
 *
 * Логика прохода — в ядре (`runKeepAlive`, под тестами); здесь только живая обвязка:
 *  - гейт на OAuth-креды (`NUXT_B24_CLIENT_ID/SECRET`) — без них рефреш невозможен;
 *  - `usePortalTokenStore` (PgStore + шифр) — источник near-expiry порталов и персиста рефреша;
 *  - каденция `TOKEN_KEEPALIVE_HOURS` (клэмп [1ч,168ч]); `unref` — таймер не держит процесс.
 * SERVER-ONLY: `~core/bitrix24` импортируется намеренно (Nitro-контур, в клиентский бандл не идёт).
 */
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const clientId = process.env.NUXT_B24_CLIENT_ID
  const clientSecret = process.env.NUXT_B24_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    logger.info('keepalive_off', { msg: 'keep-alive выключен: нет NUXT_B24_CLIENT_ID/SECRET' })
    return
  }

  const intervalMs = keepAliveIntervalMs(process.env.TOKEN_KEEPALIVE_HOURS)
  const oauth = new Bitrix24OAuth({ clientId, clientSecret })

  const tick = async (): Promise<void> => {
    const store = await usePortalTokenStore()
    if (!store) return // нет БД/ключа шифрования — рефрешить нечего (MemoryStore-dev)
    await runKeepAlive({
      listNearExpiry: () => store.listNearExpiry(),
      // access-токен near-expiry портала давно протух → accessToken рефрешит, ротируя refresh_token.
      refreshOne: async (memberId) => {
        await store.accessToken(memberId, oauth)
      },
      logger
    })
  }

  const timer = setInterval(() => {
    tick().catch((e) => logger.warn('keepalive_tick_fail', { msg: (e as Error).message }))
  }, intervalMs)
  timer.unref()
  nitroApp.hooks.hook('close', () => clearInterval(timer))
  logger.info('keepalive_on', { msg: `keep-alive включён: каждые ${intervalMs / 3_600_000} ч` })
})
