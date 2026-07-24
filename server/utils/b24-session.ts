import { createPortalAuthenticator } from '~core/bitrix24/authenticate'
import { type PortalAuthenticator } from '~core/bitrix24/frame'
import { isStrongSecret } from '~core/api/session'
import { SlidingWindowLimiter } from '~core/api/ratelimit'

/**
 * Привязка handshake app-фрейма Bitrix24 к Nitro (ISSUE #47/#49). SERVER-ONLY: `~core/bitrix24`
 * сюда импортируется намеренно (крипто/токены НЕ в клиентский бандл). Вся логика проверки —
 * в ядре (`verifyFrameAuth`/`createPortalAuthenticator`); здесь только конфиг из env + резолвер.
 */

/** Секрет подписи сессии — ТОТ ЖЕ `DASHBOARD_AUTH_SECRET`, которым `requirePortalSession` её верифицирует. */
export type B24SecretResult = { ok: true; secret: string } | { ok: false; status: 503 }

/**
 * Секрет для минта сессии портала. Fail-closed (как дашборд): без секрета или слабый (< MIN_SECRET_LEN)
 * → 503 (не выписываем сессию слабым HMAC). Симметрично `resolveDashboardAuth`: эндпоинт минтит то,
 * что гейт дашборда сможет проверить тем же секретом.
 */
export function resolveB24Secret(secret: string | undefined = process.env.DASHBOARD_AUTH_SECRET): B24SecretResult {
  // Тот же предикат, что у гейта дашборда (`resolveDashboardAuth`) — пороги не разъезжаются.
  if (!isStrongSecret(secret)) return { ok: false, status: 503 }
  return { ok: true, secret }
}

/**
 * Резолвер install-маппинга `domain → member_id` (таблица `portal`). Боевая реализация —
 * ядровая `resolveMemberIdByDomain(db, domain)` (`~core/bitrix24/portal`, под pglite-тестами):
 * её подставляет через `setPortalResolver` слой инициализации стора (`server/utils/api.ts`) при
 * заданном `DATABASE_URL` (pg-Pool). Без `DATABASE_URL` (dev/MemoryStore) — дефолт всегда
 * `undefined` ⇒ handshake fail-closed (401: «портал не установлен»). Инжектируем, чтобы #49
 * навесил tenant-scope без правки роута.
 */
let resolveMemberId: (domain: string) => Promise<string | undefined> = async () => undefined

/**
 * #49: подменить резолвер на боевой (обёртка над `resolveMemberIdByDomain` с pg-Pool):
 * `setPortalResolver((d) => resolveMemberIdByDomain(pool, d))`. Зовётся из слоя инициализации стора.
 */
export function setPortalResolver(fn: (domain: string) => Promise<string | undefined>): void {
  resolveMemberId = fn
}

/** Боевой `PortalAuthenticator` для роута: `app.info` к `{domain}` + резолв member_id (см. authenticate.ts). */
export function useB24Authenticator(): PortalAuthenticator {
  return createPortalAuthenticator({ resolveMemberId: (domain) => resolveMemberId(domain) })
}

/**
 * Rate-limit handshake-эндпоинта `/api/b24/session` (release-gate #49). Каждый валидный POST
 * инициирует исходящий `app.info` к домену из тела → без лимита это вектор амплификации/DoS
 * и перебор токенов. Handshake — редкая операция (загрузка фрейма), потому потолок низкий.
 * In-memory, на инстанс (общий стор лимитов для мульти-инстанса — #4, как и прочий анти-абьюз).
 */
const sessionLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 60_000 })

/** true — запрос с этого IP допущен (и учтён); false — лимит исчерпан (→ 429). */
export function allowB24Session(ip: string, now: Date = new Date()): boolean {
  return sessionLimiter.allow(ip, now)
}
