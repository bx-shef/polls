import { TokenCipher, loadTokenKey } from '~core/bitrix24/crypto'
import { PortalTokenStore } from '~core/bitrix24/portal'
import { createPortalClient, callMethod, type B24OAuthParams, type B24OAuthSecret } from '~core/bitrix24/client'
import { surveyRobotParams, surveyPlacements } from '~core/bitrix24/install'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { usePortalDb, logger } from './api'

/**
 * Серверная обвязка установки приложения Bitrix24 (#17). SERVER-ONLY: `~core/bitrix24` (крипто/
 * токены) сюда импортируется намеренно. Конфиг — из env (`NUXT_B24_CLIENT_ID/SECRET`,
 * `NUXT_BITRIX_TOKEN_KEY`, `DOMAIN`). Fail-closed: без полного конфига — `null` (эндпоинт → 503).
 */

/**
 * Rate-limit install-эндпоинта (§2.3 follow-up, CTO MAJOR-3). После §2.3 каждый well-formed install-POST
 * порождает ИСХОДЯЩИЙ рефреш на `oauth.bitrix.info` (сверка authoritative member_id) → эндпоинт стал
 * амплификатором: флуд → Bitrix лимитит НАС (429) → keep-alive/легитимные install получают 503. Лимитер
 * гасит потолок ДО исходящего рефреша. Install — редкая операция, потому лимит невысокий. In-memory,
 * на инстанс (общий стор для мульти-инстанса — #4). За доверенным reverse-proxy IP собирается в один
 * bucket (nginx-IP) — для анти-амплификации это ОК (кап суммарных исходящих рефрешей), X-Forwarded-For — #4.
 */
const installLimiter = new SlidingWindowLimiter({ limit: 20, windowMs: 60_000 })

/** true — install-запрос с этого IP допущен (и учтён); false — лимит исчерпан (→ 429). */
export function allowB24Install(ip: string, now: Date = new Date()): boolean {
  return installLimiter.allow(ip, now)
}

export interface B24AppConfig {
  secret: B24OAuthSecret
  /** База для HANDLER-URL встроек (наш домен), напр. `https://polls.bx-shef.by`. */
  baseUrl: string
}

/** Конфиг приложения из env или `null`, если не задан (fail-closed). */
export function b24AppConfig(): B24AppConfig | null {
  const clientId = process.env.NUXT_B24_CLIENT_ID
  const clientSecret = process.env.NUXT_B24_CLIENT_SECRET
  const domain = process.env.APP_DOMAIN ?? process.env.DOMAIN
  if (!clientId || !clientSecret || !domain) return null
  return { secret: { clientId, clientSecret }, baseUrl: `https://${domain}` }
}

/** `PortalTokenStore` поверх pg + шифр (`NUXT_BITRIX_TOKEN_KEY`); `null` без БД/ключа (fail-closed). */
export async function usePortalTokenStore(): Promise<PortalTokenStore | null> {
  const db = await usePortalDb()
  if (!db) return null
  let cipher: TokenCipher
  try {
    cipher = new TokenCipher(loadTokenKey(process.env))
  } catch {
    return null // ключ не задан/невалиден — установка fail-closed
  }
  return new PortalTokenStore(db, cipher)
}

/**
 * Регистрирует встройки приложения на портале (робот + плейсменты) клиентом `B24OAuth`.
 * Ошибки КАЖДОЙ регистрации толерируются (лог, не throw): робот недоступен на части тарифов и
 * падает с ошибкой — плейсменты всё равно дают охват; повторная установка идемпотентна по CODE/PLACEMENT.
 */
export async function registerIntegrations(authParams: B24OAuthParams, cfg: B24AppConfig): Promise<void> {
  const client = createPortalClient(authParams, cfg.secret)
  const calls: Array<[string, Record<string, unknown>]> = [
    ['bizproc.robot.add', surveyRobotParams(`${cfg.baseUrl}/api/b24/robot`)],
    ...surveyPlacements(cfg.baseUrl).map((p): [string, Record<string, unknown>] => ['placement.bind', { ...p }])
  ]
  for (const [method, params] of calls) {
    try {
      await callMethod(client, method, params)
    } catch (e) {
      // Толерируем (тариф/повторная установка) — не валим всю установку из-за одной встройки.
      logger.warn('b24_register_skip', { msg: `${method} не зарегистрирован: ${(e as Error).message}` })
    }
  }
}
