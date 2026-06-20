import { createPortalAuthenticator } from '~core/bitrix24/authenticate'
import { type PortalAuthenticator } from '~core/bitrix24/frame'
import { isStrongSecret } from '~core/api/session'

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
 * Резолвер install-маппинга `domain → member_id` (таблица `portal`). #49: подключается к PgStore
 * (`select member_id from portal where domain=$1`) при настроенном `DATABASE_URL`. Пока стора нет
 * (Nitro на MemoryStore+seed, #6) — резолвер всегда `undefined` ⇒ handshake fail-closed (401:
 * «портал не установлен»). Инжектируем, чтобы #49 подменил его без правки роута.
 */
let resolveMemberId: (domain: string) => Promise<string | undefined> = async () => undefined

/** #49: подменить резолвер на PgStore-backed (вызывается из слоя инициализации стора). */
export function setPortalResolver(fn: (domain: string) => Promise<string | undefined>): void {
  resolveMemberId = fn
}

/** Боевой `PortalAuthenticator` для роута: `app.info` к `{domain}` + резолв member_id (см. authenticate.ts). */
export function useB24Authenticator(): PortalAuthenticator {
  return createPortalAuthenticator({ resolveMemberId: (domain) => resolveMemberId(domain) })
}
