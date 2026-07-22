import { nullLogger, type Logger } from '../obs/logger'

/**
 * Keep-alive рефреш OAuth-токенов портала (docs/improvement-plan.md §2.4). refresh_token
 * Bitrix24 живёт ~180 дней; ленивый рефреш срабатывает ТОЛЬКО на REST-вызове, поэтому
 * установленный, но простаивающий портал (никто не проходит опрос → нет вызовов) теряет
 * refresh_token на 180-й день. Крон периодически рефрешит порталы у истечения
 * (`PortalTokenStore.listNearExpiry` — полоса у истечения по `updated_at`, батч уже с капом).
 *
 * Framework-agnostic ядро: DI (`listNearExpiry`/`refreshOne`), без БД/сети/таймеров —
 * под юнит-тестами. Живой таймер + боевые зависимости — Nitro-плагин `server/plugins/keepalive.ts`.
 */

const HOUR_MS = 3_600_000
/** Дефолт каденции keep-alive (часов). B24 предупреждает: частый рефреш → риск авто-блока. */
const DEFAULT_KEEPALIVE_HOURS = 24
const MIN_KEEPALIVE_HOURS = 1
/**
 * Верхний клэмп КРИТИЧЕН: `setInterval` с задержкой > 2³¹−1 мс (~24.8 сут) переполняется —
 * Node молча схлопывает её в 1 мс (tight loop). 168ч (7 сут) — с большим запасом ниже предела.
 */
const MAX_KEEPALIVE_HOURS = 168

/**
 * Интервал keep-alive в мс из env-значения (часы): парс → клэмп `[1ч, 168ч]` → мс.
 * Невалидное/непозитивное/нечисловое → дефолт 24ч. Верхний клэмп защищает от overflow `setInterval`.
 */
export function keepAliveIntervalMs(hoursEnv: string | undefined, dfltHours = DEFAULT_KEEPALIVE_HOURS): number {
  const parsed = Number(hoursEnv)
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : dfltHours
  const clamped = Math.min(Math.max(hours, MIN_KEEPALIVE_HOURS), MAX_KEEPALIVE_HOURS)
  return clamped * HOUR_MS
}

export interface KeepAliveDeps {
  /** member_id порталов у истечения refresh_token (батч уже с капом — `PortalTokenStore.listNearExpiry`). */
  listNearExpiry: () => Promise<string[]>
  /**
   * Форс-рефреш одного портала. Обычно `store.accessToken(memberId, oauth)`: у near-expiry
   * портала access-токен (жизнь ~1ч) давно протух → `accessToken` рефрешит, ротируя refresh_token
   * и штампуя `updated_at`. Бросает при неудаче рефреша.
   */
  refreshOne: (memberId: string) => Promise<void>
  logger?: Logger
}

export interface KeepAliveResult {
  /** Сколько порталов было в полосе у истечения. */
  total: number
  refreshed: number
  failed: number
}

/**
 * Один проход keep-alive: рефрешит все порталы у истечения. Ошибки ИЗОЛИРОВАНЫ пер-портал
 * (один мёртвый/отозванный грант не останавливает остальных). Возвращает счётчики.
 */
export async function runKeepAlive(deps: KeepAliveDeps): Promise<KeepAliveResult> {
  const log = deps.logger ?? nullLogger
  const members = await deps.listNearExpiry()
  let refreshed = 0
  let failed = 0
  for (const memberId of members) {
    try {
      await deps.refreshOne(memberId)
      refreshed++
    } catch (e) {
      failed++
      log.warn('keepalive_refresh_fail', { msg: `Портал ${memberId}: keep-alive рефреш не удался (${(e as Error).message})` })
    }
  }
  if (members.length > 0) {
    log.info('keepalive_run', { msg: `keep-alive: обновлено ${refreshed}/${members.length}, ошибок ${failed}` })
  }
  return { total: members.length, refreshed, failed }
}
