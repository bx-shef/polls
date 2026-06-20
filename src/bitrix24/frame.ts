import { z } from 'zod'
import { OAuthError } from './oauth'
import { signSession, type PortalSession } from '../api/session'

/**
 * Handshake app-фрейма Bitrix24 (ISSUE #47) — ЯДРО-рантайм, без HTTP/DOM.
 *
 * При загрузке приложения в iframe портала Bitrix24 POST'ит параметры авторизации
 * (`BX24.getAuth`: `DOMAIN`/`member_id`/`AUTH_ID`/`AUTH_EXPIRES`/…). Эти параметры приходят на
 * НАШ публичный эндпоинт и потому НЕДОВЕРЕННЫ (их может подделать кто угодно). Безопасность:
 *  1. `DOMAIN` — управляемый злоумышленником → SSRF при использовании как хост REST-вызова:
 *     валидируем по allowlist Bitrix24-хостов (`isAllowedPortalDomain`), как просит `oauth.ts:24`.
 *  2. `member_id` (tenant-ключ) НЕЛЬЗЯ брать из сырого POST: иначе при валидном СВОЁМ токене
 *     можно выписать сессию на ЧУЖОЙ member_id (cross-tenant). Поэтому `verifyFrameAuth` берёт
 *     member_id из АВТОРИТЕТНОГО источника (`authenticate` — живая проверка токена) и СВЕРЯЕТ
 *     его с заявленным в POST; расхождение → отказ.
 *
 * HTTP инжектируется (`authenticate`) — логика проверяется юнит-тестами без живого портала.
 * Привязка эндпоинта (`/api/b24/session` + cookie) и боевой `authenticate` (через
 * `PortalTokenStore`/OAuth) — слой связки с общим стором (#49).
 */

/** Верхняя граница `AUTH_EXPIRES` (сек): 1 год — защита от переполнения Date/абсурдных TTL. */
const MAX_AUTH_EXPIRES = 366 * 24 * 3600

/** Параметры авторизации фрейма (минимум для аутентификации; прочее — LANG/PLACEMENT_OPTIONS — игнор). */
export const frameAuthSchema = z.object({
  DOMAIN: z.string().min(1).max(253),
  member_id: z.string().min(1).max(200),
  AUTH_ID: z.string().min(1).max(4096),
  /** unix-секунд до протухания access-token (приходит строкой из form-POST). */
  AUTH_EXPIRES: z.coerce.number().int().nonnegative().max(MAX_AUTH_EXPIRES),
  PLACEMENT: z.string().max(200).optional()
})
export type FrameAuth = z.infer<typeof frameAuthSchema>

/** Безопасно распарсить недоверенный POST фрейма → `FrameAuth` или `null` (мусор/неполнота). */
export function parseFrameAuth(raw: unknown): FrameAuth | null {
  const r = frameAuthSchema.safeParse(raw)
  return r.success ? r.data : null
}

/**
 * Allowlist облачных доменов Bitrix24: `<portal>.bitrix24.<tld>` (вкл. двойные tld `.com.br`).
 * Дефолт намеренно узкий — self-hosted порталы передают свой RegExp. SSRF-гард: ровно ОДИН
 * лейбл портала, литеральное `.bitrix24.`, якоря — никаких `slash`/`:`/`@`/поддоменных трюков.
 */
const DEFAULT_PORTAL_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bitrix24\.[a-z]{2,4}(?:\.[a-z]{2,3})?$/

/** Доверенный ли хост портала (для исходящего REST-вызова). `domain` — голый хост, без схемы/порта. */
export function isAllowedPortalDomain(domain: string, allow: RegExp = DEFAULT_PORTAL_DOMAIN): boolean {
  if (typeof domain !== 'string' || domain.length > 253) return false
  return allow.test(domain.toLowerCase())
}

/** Авторитетная проверка токена фрейма: возвращает РЕАЛЬНЫЙ member_id (из живого REST/OAuth). */
export type PortalAuthenticator = (input: { domain: string; authId: string }) => Promise<{ memberId: string }>

export interface VerifyFrameOptions {
  authenticate: PortalAuthenticator
  /** allowlist доменов (self-hosted переопределяет). */
  allowedDomain?: RegExp
}

/** Подтверждённый портал: tenant-ключ из авторитетного источника + проверенный домен. */
export interface VerifiedPortal {
  portalId: string
  domain: string
}

/**
 * Проверить handshake фрейма → подтверждённый портал, либо `OAuthError`. SSRF-гард домена →
 * авторитетная проверка токена → СВЕРКА member_id (анти-cross-tenant). `portalId` берётся из
 * авторитетного ответа, НЕ из сырого POST.
 */
export async function verifyFrameAuth(frame: FrameAuth, opts: VerifyFrameOptions): Promise<VerifiedPortal> {
  if (!isAllowedPortalDomain(frame.DOMAIN, opts.allowedDomain)) {
    throw new OAuthError(`Недоверенный домен портала: ${frame.DOMAIN}`)
  }
  const { memberId } = await opts.authenticate({ domain: frame.DOMAIN, authId: frame.AUTH_ID })
  if (!memberId || memberId !== frame.member_id) {
    // Токен валиден, но принадлежит другому порталу, чем заявлено в POST → не выписываем сессию.
    throw new OAuthError('member_id фрейма не совпал с владельцем токена (cross-tenant)')
  }
  return { portalId: memberId, domain: frame.DOMAIN }
}

/** Срок сессии дашборда по умолчанию: 8 часов (наша сессия независима от TTL b24-токена). */
export const DEFAULT_SESSION_TTL_SEC = 8 * 3600

/** Выписать подписанную сессию портала из подтверждённого фрейма (для cookie `polls_portal`). */
export function mintPortalSession(
  portal: VerifiedPortal,
  secret: string,
  ttlSec: number = DEFAULT_SESSION_TTL_SEC,
  now: number = Math.floor(Date.now() / 1000)
): { token: string; session: PortalSession } {
  const session: PortalSession = { portalId: portal.portalId, exp: now + ttlSec }
  return { token: signSession(session, secret), session }
}
