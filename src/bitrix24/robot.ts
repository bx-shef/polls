import { z } from 'zod'
import { verifyApplicationToken, dealToCrmContext } from './deal-event'
import { dealIdFromDocumentId, handleDealTrigger, type TriggerResult, type TriggerStore } from './trigger'
import type { InvitationStore } from '../api/invitation'

/**
 * Оркестрация робота автоматизации «Запустить опрос» (#122) — ЯДРО-рантайм, без HTTP/портала.
 *
 * **Зачем отдельный путь рядом с `event.bind`:** робот встаёт в автоматизацию стадии и вызывается ровно
 * НА ВХОДЕ в неё — то есть даёт ровно ту семантику «сделка дошла до стадии», которой нет у события
 * `ONCRMDEALUPDATE` (оно приходит на любое изменение). Поэтому здесь НЕ нужна проверка истории стадий
 * (`stage-transition.ts`), которой обвешан событийный путь.
 *
 * **Почему не заменяет событие:** робот доступен не на всех тарифах (bizproc), а `event.bind` работает
 * везде. Оба пути ведут в один `handleDealTrigger`; какой использовать — выбирает оператор в настройках.
 *
 * Порядок гейтов тот же, что в `deal-update.ts`: недоверенный POST → мягкий парс → сверка
 * `application_token` (constant-time) → **только потом** догрузка сделки токеном ПОРТАЛА. I/O инжектируется.
 */

/** Код робота в автоматизации портала (регистрируется при установке, `surveyRobotParams`). */
export { SURVEY_ROBOT_CODE } from './install'

/**
 * ⚠️ Wire-формат: Bitrix шлёт робота как **form-urlencoded в bracket-нотации**, поэтому после
 * `parseBracketForm` массив приходит НЕ массивом, а объектом с числовыми ключами:
 * `document_id[0]=crm&document_id[1]=…` → `{ '0': 'crm', '1': … }`. Схема, ждущая `z.array`, отвергла бы
 * реальный POST — и робот молча не работал бы в бою (ровно такой тихий no-op уже ловили на `event.bind`).
 * Поэтому нормализуем обе формы к массиву строк по возрастанию числового ключа.
 */
function toStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => [Number(k), val] as const)
      .filter(([k, val]) => Number.isInteger(k) && k >= 0 && typeof val === 'string')
      .sort(([a], [b]) => a - b)
    return entries.length ? entries.map(([, val]) => val as string) : undefined
  }
  return undefined
}

/**
 * Полезная нагрузка робота. `document_id` — `['crm','CCrmDocumentDeal','DEAL_759']` (после нормализации
 * выше). Схема мягкая: лишние поля (`code`, `event_token`, `properties`, `ts`) не мешают.
 */
const robotEventSchema = z.object({
  document_id: z.preprocess(toStringArray, z.array(z.string()).min(1)),
  auth: z.object({
    member_id: z.string().min(1),
    application_token: z.string().min(1)
  })
})
export type RobotEvent = z.infer<typeof robotEventSchema>

/** Безопасно распарсить недоверенный POST робота → `RobotEvent` или `null` (мусор/неполнота). */
export function parseRobotEvent(raw: unknown): RobotEvent | null {
  const r = robotEventSchema.safeParse(raw)
  return r.success ? r.data : null
}

export type RobotOutcome =
  /** Не наш/битый POST либо `document_id` не про сделку — отвечаем 200, ничего не делаем. */
  | { kind: 'ignored'; reason: 'parse' | 'not_deal' }
  /** `application_token` не сошёлся либо портал не установлен — ничего не триггерим. */
  | { kind: 'forged'; reason: 'unknown_portal' | 'token_mismatch'; memberId: string }
  /** Верифицировано: создано 0..N приглашений (0 — стадия не триггерит ни один опрос). */
  | { kind: 'ok'; results: TriggerResult[]; dealId: number }

export interface RobotDeps {
  /** Сохранённый `application_token` портала по `member_id`; `undefined` — портал не установлен. */
  storedApplicationToken: (memberId: string) => Promise<string | undefined>
  /** Догрузка сделки токеном ПОРТАЛА. Зовётся ТОЛЬКО после успешной сверки `application_token`. */
  fetchDeal: (
    dealId: number,
    memberId: string
  ) => Promise<{ deal: Record<string, unknown>; productRows: Array<Record<string, unknown>> }>
  store: TriggerStore
  invitations: InvitationStore
  now?: Date
}

export async function runRobotTrigger(raw: unknown, deps: RobotDeps): Promise<RobotOutcome> {
  const ev = parseRobotEvent(raw)
  if (!ev) return { kind: 'ignored', reason: 'parse' }

  const dealId = dealIdFromDocumentId(ev.document_id)
  if (!dealId) return { kind: 'ignored', reason: 'not_deal' } // робот повесили на другой тип документа

  // Анти-форджери ПЕРЕД любым исходящим вызовом (как в deal-update).
  const expected = await deps.storedApplicationToken(ev.auth.member_id)
  if (!verifyApplicationToken(ev.auth.application_token, expected ?? '')) {
    return {
      kind: 'forged',
      reason: expected === undefined ? 'unknown_portal' : 'token_mismatch',
      memberId: ev.auth.member_id
    }
  }

  const { deal, productRows } = await deps.fetchDeal(dealId, ev.auth.member_id)
  const context = dealToCrmContext(deal, productRows)
  // Проверки истории стадий НЕТ намеренно: робот вызывается ровно на входе в стадию.
  const results = await handleDealTrigger({
    store: deps.store,
    invitations: deps.invitations,
    context,
    now: deps.now
  })
  return { kind: 'ok', results, dealId }
}
