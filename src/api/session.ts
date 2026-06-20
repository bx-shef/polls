import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * SERVER-ONLY (использует `node:crypto`). Сессия дашборда (контур B, #47): к какому порталу
 * Bitrix24 относится открывший дашборд. Токен ПОДПИСЫВАЕТСЯ (HMAC-SHA256), а не шифруется —
 * payload не секрет (tenant-ключ + срок), но его нельзя подделать без серверного секрета.
 * Формат: `base64url(JSON).base64url(HMAC)`.
 *
 * Минтит сессию слой связки Bitrix24 (handshake app-фрейма — следующий слайс #47); здесь —
 * sign/verify + чистое решение гейта (`resolveDashboardAuth`, тестируемо, без env/h3).
 */
export interface PortalSession {
  /** tenant-ключ: `member_id` портала Bitrix24. */
  portalId: string
  /** срок годности, unix-секунды. */
  exp: number
}

/** Минимальная длина серверного секрета (слабый/пустой → отказ, а не слабый HMAC). */
export const MIN_SECRET_LEN = 32
/** Sentinel-portalId для dev-открытого режима (не коллидирует с реальным `member_id`). */
export const DEV_PORTAL_ID = '__dev__'

const b64url = (buf: Buffer): string => buf.toString('base64url')
const hmacRaw = (payload: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(payload).digest()

/** Подписать сессию: `base64url(JSON).base64url(HMAC-SHA256(payload))`. */
export function signSession(session: PortalSession, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(session)))
  return `${payload}.${b64url(hmacRaw(payload, secret))}`
}

/**
 * Проверить и распарсить токен → сессия или `null` (подделка/просрочка/мусор/чужой/пустой секрет).
 * Сравнение подписи — constant-time над СЫРЫМИ байтами HMAC. `now` — для тестов (unix-секунды).
 */
export function verifySession(
  token: unknown,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): PortalSession | null {
  if (typeof token !== 'string' || !secret) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payload = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1), 'base64url')
  const expected = hmacRaw(payload, secret)
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    return null
  }
  if (!isPortalSession(parsed) || parsed.exp <= now) return null
  return parsed
}

function isPortalSession(v: unknown): v is PortalSession {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    typeof s.portalId === 'string' &&
    s.portalId.length > 0 &&
    typeof s.exp === 'number' &&
    Number.isFinite(s.exp)
  )
}

/** Окружение гейта (без env/h3 — чистые значения для тестируемости). */
export interface DashboardAuthEnv {
  secret?: string
  devOpen: boolean
  isProduction: boolean
}
export type DashboardAuthDecision =
  | { ok: true; session: PortalSession }
  | { ok: false; status: 401 | 503 }

/**
 * Чистое решение гейта дашборда (#47), fail-closed. Политика:
 *  - секрет валидной длины → нужна валидная сессия из `token`, иначе **401**;
 *  - секрет задан, но слабый/короткий (< {@link MIN_SECRET_LEN}) → **503** (не используем слабый HMAC);
 *  - без секрета и (`devOpen` ИЛИ не production) → dev-сессия (`DEV_PORTAL_ID`);
 *  - без секрета в production без `devOpen` → **503** (не отдаём PII без конфигурации auth).
 * Секрет имеет ПРИОРИТЕТ над `devOpen`: при заданном секрете dev-открытость не действует.
 */
export function resolveDashboardAuth(
  env: DashboardAuthEnv,
  token: unknown,
  now: number = Math.floor(Date.now() / 1000)
): DashboardAuthDecision {
  if (env.secret) {
    if (env.secret.length < MIN_SECRET_LEN) return { ok: false, status: 503 }
    const session = verifySession(token, env.secret, now)
    return session ? { ok: true, session } : { ok: false, status: 401 }
  }
  if (env.devOpen || !env.isProduction) {
    return { ok: true, session: { portalId: DEV_PORTAL_ID, exp: now + 3600 } }
  }
  return { ok: false, status: 503 }
}
