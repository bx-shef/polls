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

/**
 * Верхняя граница `ts` (unix-СЕКУНДЫ, ~год 2100). Больше — вероятно мусор/атака: огромный `ts`
 * навсегда поднял бы `portal_tombstone.deleted_ts` через `greatest()`, заблокировав будущую
 * переустановку тумбстоун-гардом. За границей → деградируем в `undefined` (используется `nowSec`).
 */
const MAX_TS = 4_102_444_800

export const uninstallEventSchema = z.object({
  event: z.string().refine((s) => s.toUpperCase() === 'ONAPPUNINSTALL', 'не ONAPPUNINSTALL'),
  /**
   * `CLEAN` — выбор пользователя «Очистить данные приложения»: `1` стереть / `0` сохранить (переустановка).
   * `.catch(undefined)`: мусорное значение НЕ роняет весь парс события (иначе легитимный uninstall ушёл бы
   * в install-ветку → 400 вместо ack), а безопасно деградирует в `undefined` → `clean:false` (не стираем).
   */
  data: z.object({ CLEAN: z.coerce.number().int().optional().catch(undefined) }).optional().catch(undefined),
  auth: z.object({
    member_id: z.string().min(1).max(200),
    application_token: z.string().min(1).max(200)
  }),
  /** top-level `ts` вебхука (unix-СЕКУНДЫ, строкой). Кап `MAX_TS` + `.catch` → мусор/огромное → `undefined`. */
  ts: z.coerce.number().int().nonnegative().max(MAX_TS).optional().catch(undefined)
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
 *  - совпал → `ok` с `memberId`, `deletedTs` (из события либо `nowSec`) и `clean` (стирать ли данные).
 * `clean` = `data.CLEAN === 1` (пользователь просил очистку); иначе (0/отсутствует) данные СОХРАНЯЕМ
 * (переустановка). Вызывающий на `ok && clean` зовёт `deletePortal`; на `ok && !clean` — ничего не
 * трогает (данные оставлены сознательно); на не-ok — ничего не удаляет.
 */
export type UninstallVerdict =
  | { ok: true; memberId: string; deletedTs: number; clean: boolean }
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
  return {
    ok: true,
    memberId: event.auth.member_id,
    deletedTs: event.ts ?? nowSec,
    clean: event.data?.CLEAN === 1
  }
}
