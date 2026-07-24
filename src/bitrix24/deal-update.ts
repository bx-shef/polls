import { parseDealUpdateEvent, verifyApplicationToken, dealToCrmContext } from './deal-event'
import { handleDealTrigger, type TriggerResult, type TriggerStore } from './trigger'
import type { InvitationStore } from '../api/invitation'

/**
 * Оркестрация авто-триггера `ONCRMDEALUPDATE` (event.bind, ISSUE #17) — ЯДРО-рантайм, без HTTP/портала.
 * Собирает уже протестированные кирпичи в безопасном порядке: недоверенный POST → мягкий парс →
 * сверка `application_token` (constant-time, анти-форджери) → **только потом** догрузка сделки токеном
 * ПОРТАЛА → снимок `CrmContext` → `handleDealTrigger` (по стадии → приглашения на опрос).
 *
 * I/O инжектируется (`storedApplicationToken`/`fetchDeal`/`store`/`invitations`) → под тестами без портала.
 * Ключевой инвариант (как в trigger.ts): `context` строится из АВТОРИТЕТНОГО `crm.deal.get` ТОЛЬКО ПОСЛЕ
 * успешной `verifyApplicationToken` — иначе open-trigger. Здесь порядок гарантирован: `fetchDeal` зовётся
 * ниже сверки токена, а на форджери — не зовётся вовсе (нет амплификации исходящих REST от подделки).
 */

export type DealUpdateOutcome =
  /** Не наш/битый POST — портал online-события не ретраит, наружу отвечаем 200. */
  | { kind: 'ignored'; reason: 'parse' }
  /** `application_token` не сошёлся (подделка) либо портал не установлен — ничего не триггерим. */
  | { kind: 'forged'; reason: 'unknown_portal' | 'token_mismatch' }
  /** Верифицировано: создано 0..N приглашений (0 — стадия сделки не триггерит ни один опрос). */
  | { kind: 'ok'; results: TriggerResult[] }

export interface DealUpdateDeps {
  /** Сохранённый `application_token` портала по `member_id` (из `PortalTokenStore.load`); `undefined` — портал не установлен. */
  storedApplicationToken: (memberId: string) => Promise<string | undefined>
  /**
   * Догрузка сделки токеном ПОРТАЛА (не события): `crm.deal.get` + товарные позиции. `memberId` — чтобы
   * поднять токен нужного портала. Зовётся ТОЛЬКО после успешной сверки `application_token`.
   */
  fetchDeal: (
    dealId: number,
    memberId: string
  ) => Promise<{ deal: Record<string, unknown>; productRows: Array<Record<string, unknown>> }>
  store: TriggerStore
  invitations: InvitationStore
  now?: Date
}

export async function runDealUpdate(raw: unknown, deps: DealUpdateDeps): Promise<DealUpdateOutcome> {
  const ev = parseDealUpdateEvent(raw)
  if (!ev) return { kind: 'ignored', reason: 'parse' }

  // Анти-форджери ПЕРЕД любым исходящим вызовом: сверяем присланный application_token с сохранённым для
  // заявленного member_id (constant-time). Портал не установлен (`undefined`) → сверка с '' → false.
  const expected = await deps.storedApplicationToken(ev.auth.member_id)
  if (!verifyApplicationToken(ev.auth.application_token, expected ?? '')) {
    return { kind: 'forged', reason: expected === undefined ? 'unknown_portal' : 'token_mismatch' }
  }

  // Токен сошёлся → догружаем АВТОРИТЕТНЫЕ поля сделки токеном портала и строим снимок контекста.
  const { deal, productRows } = await deps.fetchDeal(ev.data.FIELDS.ID, ev.auth.member_id)
  const context = dealToCrmContext(deal, productRows)
  const results = await handleDealTrigger({
    store: deps.store,
    invitations: deps.invitations,
    context,
    now: deps.now
  })
  return { kind: 'ok', results }
}
