import { z } from 'zod'
import { verifyApplicationToken } from './deal-event'

/**
 * Обработка удаления приложения с портала (ONAPPUNINSTALL, docs/improvement-plan.md §2.1).
 * Требование Маркета: при удалении стереть данные/PII портала (делает `PortalTokenStore.deletePortal`).
 *
 * Модель доверия Bitrix24: у `ONAPPUNINSTALL` нет иных данных для аутентификации, кроме
 * `application_token` — секрета «приложение↔портал», выданного при установке и сохранённого нами
 * (в зашифрованном blob токенов, `oauthTokensSchema.applicationToken`). Поэтому единственный способ
 * доказать подлинность uninstall — **constant-time сверка** присланного `application_token` с
 * сохранённым для этого портала (`verifyApplicationToken`, переиспользуем из `deal-event`).
 *
 * Framework-agnostic ядро: чистый парс недоверенного POST + чистый вердикт (DI на сохранённый токен).
 * Nitro-эндпоинт (bracket-form-парс POST → `parseUninstallEvent` → загрузка токена → `decideUninstall`
 * → `deletePortal`) — фаза связки (живой портал).
 */

export const uninstallEventSchema = z.object({
  event: z.string().refine((s) => s.toUpperCase() === 'ONAPPUNINSTALL', 'не ONAPPUNINSTALL'),
  auth: z.object({
    member_id: z.string().min(1).max(200),
    application_token: z.string().min(1).max(200)
  }),
  /** top-level `ts` вебхука (unix-СЕКУНДЫ) — для тумбстоуна `deletePortal`. Не все доставки несут → опционален. */
  ts: z.coerce.number().int().nonnegative().optional()
})
export type UninstallEvent = z.infer<typeof uninstallEventSchema>

/** Мягкий zod-парс недоверенного POST удаления → `UninstallEvent` | `null` (не бросает). */
export function parseUninstallEvent(raw: unknown): UninstallEvent | null {
  const r = uninstallEventSchema.safeParse(raw)
  return r.success ? r.data : null
}

/**
 * Вердикт по uninstall-событию (чистый, DI на сохранённый `application_token` портала):
 *  - нет сохранённого токена (портал не установлен / токен не был захвачен) → `unknown_portal`;
 *  - `application_token` не совпал (constant-time) → `bad_token` (подделка);
 *  - совпал → `ok` с `memberId` и `deletedTs` (из события либо `nowSec`, если событие без `ts`).
 * Вызывающий на `ok` зовёт `deletePortal(memberId, deletedTs)`; на не-ok — ничего не удаляет.
 */
export type UninstallVerdict =
  | { ok: true; memberId: string; deletedTs: number }
  | { ok: false; reason: 'unknown_portal' | 'bad_token' }

export function decideUninstall(
  event: UninstallEvent,
  storedApplicationToken: string | undefined,
  nowSec: number
): UninstallVerdict {
  if (!storedApplicationToken) return { ok: false, reason: 'unknown_portal' }
  if (!verifyApplicationToken(event.auth.application_token, storedApplicationToken)) {
    return { ok: false, reason: 'bad_token' }
  }
  return { ok: true, memberId: event.auth.member_id, deletedTs: event.ts ?? nowSec }
}
