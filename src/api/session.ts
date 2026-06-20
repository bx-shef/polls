import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Сессия дашборда (контур B, #47): к какому порталу Bitrix24 относится открывший дашборд.
 * Токен ПОДПИСЫВАЕТСЯ (HMAC-SHA256), а не шифруется — payload не секрет (там только tenant-ключ
 * и срок), но его нельзя подделать без серверного секрета. Формат: `base64url(JSON).base64url(HMAC)`.
 *
 * Это framework-agnostic примитив (node:crypto, как `bitrix24/crypto.ts`). Минтит сессию слой
 * связки Bitrix24 (handshake app-фрейма — следующий слайс #47); здесь — только sign/verify.
 */
export interface PortalSession {
  /** tenant-ключ: `member_id` портала Bitrix24. */
  portalId: string
  /** срок годности, unix-секунды. */
  exp: number
}

const b64url = (buf: Buffer): string => buf.toString('base64url')
const hmac = (payload: string, secret: string): string =>
  b64url(createHmac('sha256', secret).update(payload).digest())

/** Подписать сессию: `base64url(JSON).base64url(HMAC-SHA256(payload))`. */
export function signSession(session: PortalSession, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(session)))
  return `${payload}.${hmac(payload, secret)}`
}

/**
 * Проверить и распарсить токен → сессия или `null` (подделка/просрочка/мусор/чужой секрет).
 * Сравнение подписи — constant-time (`timingSafeEqual`). `now` — для тестов (unix-секунды).
 */
export function verifySession(
  token: unknown,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): PortalSession | null {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payload = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(hmac(payload, secret))
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
  return typeof s.portalId === 'string' && s.portalId.length > 0 && typeof s.exp === 'number'
}
