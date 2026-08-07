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
 *
 * ⚠️ **Событие приходит на ЛЮБОЙ апдейт, не на переход стадии** (`ONCRMDEALUPDATE` так устроен) и несёт
 * лишь `data.FIELDS.ID` (без стадии) ⇒ `fetchDeal` (2 REST к порталу) идёт на КАЖДЫЙ апдейт сделки ДО
 * фильтра по стадии. Чтобы не рассылать приглашение на каждое редактирование сделки, стоящей в триггерной
 * стадии, переход подтверждается историей портала: `confirmStageEntry` (см. `stage-transition.ts`).
 * Проверка **опциональна** — путь робота автоматизации её не использует (робот вызывается ровно на входе
 * в стадию), а ядровые тесты могут её не подключать.
 */

export type DealUpdateOutcome =
  /** Не наш/битый POST — портал online-события не ретраит, наружу отвечаем 200. */
  | { kind: 'ignored'; reason: 'parse' }
  /**
   * `application_token` не сошёлся (подделка) либо портал не установлен / у него нет сохранённого
   * `application_token` — ничего не триггерим. `memberId` (заявленный, недоверенный) — для диагностики лога.
   */
  | { kind: 'forged'; reason: 'unknown_portal' | 'token_mismatch'; memberId: string }
  /** Верифицировано: создано 0..N приглашений (0 — стадия сделки не триггерит ни один опрос). */
  | { kind: 'ok'; results: TriggerResult[] }
  /**
   * Верифицировано, стадия триггерная, но перехода «только что» НЕ было (обычный апдейт сделки, давно
   * стоящей в этой стадии) либо историю не удалось подтвердить → приглашение не выписываем.
   */
  | { kind: 'skipped'; reason: 'stale_stage'; dealId: number; stageId: string }

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
  /**
   * Подтверждение РЕАЛЬНОГО перехода в стадию (история портала, `crm.stagehistory.list`): `true` — переход
   * произошёл только что, приглашаем. **Не задана** → проверки нет (путь робота автоматизации: он и так
   * вызывается ровно на входе в стадию). Ошибку REST вызывающий гасит в `false` — молчание безопаснее
   * ложной рассылки клиентам.
   */
  confirmStageEntry?: (dealId: number, stageId: string, memberId: string) => Promise<boolean>
  now?: Date
}

export async function runDealUpdate(raw: unknown, deps: DealUpdateDeps): Promise<DealUpdateOutcome> {
  const ev = parseDealUpdateEvent(raw)
  if (!ev) return { kind: 'ignored', reason: 'parse' }

  // Анти-форджери ПЕРЕД любым исходящим вызовом: сверяем присланный application_token с сохранённым для
  // заявленного member_id (constant-time). Портал не установлен (`undefined`) → сверка с '' → false.
  const expected = await deps.storedApplicationToken(ev.auth.member_id)
  if (!verifyApplicationToken(ev.auth.application_token, expected ?? '')) {
    // `unknown_portal` покрывает и «портал не установлен», и «установлен, но в blob нет application_token»
    // (оба → `expected === undefined`): для решения (ничего не триггерить) разница несущественна.
    return { kind: 'forged', reason: expected === undefined ? 'unknown_portal' : 'token_mismatch', memberId: ev.auth.member_id }
  }

  // Токен сошёлся → догружаем АВТОРИТЕТНЫЕ поля сделки токеном портала и строим снимок контекста.
  const { deal, productRows } = await deps.fetchDeal(ev.data.FIELDS.ID, ev.auth.member_id)
  const context = dealToCrmContext(deal, productRows)

  // Событие приходит на любой апдейт → подтверждаем, что переход в эту стадию был ТОЛЬКО ЧТО.
  // ⚠️ Порядок важен: СНАЧАЛА дешёвый гейт по БД (`surveysTriggeredBy`, GIN-индекс), и только если стадия
  // реально запускает опросы — дорогой REST к порталу за историей. Иначе `crm.stagehistory.list` уходил бы
  // на КАЖДЫЙ апдейт любой сделки в любой стадии (в воронке их большинство), и при массовом редактировании
  // портал упёрся бы в лимит запросов — а его ошибка гасится в `false`, то есть терялись бы легитимные переходы.
  // Стадии в контексте нет — триггерить нечего (ниже `handleDealTrigger` вернёт []).
  let triggeredSurveyKeys: readonly string[] | undefined
  if (deps.confirmStageEntry && context.dealStageId) {
    triggeredSurveyKeys = await deps.store.surveysTriggeredBy(context.dealStageId)
    if (triggeredSurveyKeys.length > 0) {
      const fresh = await deps.confirmStageEntry(ev.data.FIELDS.ID, context.dealStageId, ev.auth.member_id)
      if (!fresh) {
        return { kind: 'skipped', reason: 'stale_stage', dealId: ev.data.FIELDS.ID, stageId: context.dealStageId }
      }
    }
  }

  const results = await handleDealTrigger({
    store: deps.store,
    invitations: deps.invitations,
    context,
    now: deps.now,
    // Список уже получен гейтом выше — не спрашиваем БД повторно за одно событие.
    triggeredSurveyKeys
  })
  return { kind: 'ok', results }
}
