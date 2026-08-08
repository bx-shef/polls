import { createPortalAuthenticator } from '~core/bitrix24/authenticate'
import { type PortalAuthenticator } from '~core/bitrix24/frame'
import { isStrongSecret } from '~core/api/session'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { timeoutFetch } from './b24-fetch'

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

/** Боевой `PortalAuthenticator` для роута: `profile` к `{domain}` + резолв member_id (см. authenticate.ts).
 *  `fetch` с таймаутом — зависший `profile` иначе держал бы соединение Nitro handshake до дефолта undici. */
export function useB24Authenticator(): PortalAuthenticator {
  return createPortalAuthenticator({ resolveMemberId: (domain) => resolveMemberId(domain), fetch: timeoutFetch })
}

/**
 * Rate-limit handshake-эндпоинта `/api/b24/session` (release-gate #49). Каждый валидный POST
 * инициирует исходящий `profile` к домену ИЗ ТЕЛА запроса → без лимита это амплификатор с выбираемой
 * целью и заодно перебор токенов. In-memory, на инстанс (общий стор — #4).
 *
 * Потолков два, как и у install, и по той же причине: пер-IP защищает от одного шумного источника,
 * глобальный — держит НАШ суммарный исходящий поток. Пока ключом был адрес прокси, второй получался
 * сам собой; с реальным адресом клиента его пришлось поставить явно.
 *
 * ⚠️ Пер-IP потолок низкий (handshake — загрузка фрейма, операция редкая), но именно он до правки
 * адреса клиента считался на ВЕСЬ портал: за прокси все сотрудники приходили одним ключом, и
 * одиннадцатое открытие виджета за минуту получало 429. На живом прогоне это выглядело бы случайным
 * миганием связки.
 */
const sessionLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 60_000 })
const sessionGlobalLimiter = new SlidingWindowLimiter({ limit: 120, windowMs: 60_000 })
const GLOBAL_KEY = 'all'

/** true — запрос допущен (и учтён) обоими потолками; false — лимит исчерпан (→ 429). */
export function allowB24Session(ip: string, now: Date = new Date()): boolean {
  return sessionLimiter.allow(ip, now) && sessionGlobalLimiter.allow(GLOBAL_KEY, now)
}
