import { z } from 'zod'
import { verifyApplicationToken, dealToCrmContext } from './deal-event'
import {
  dealIdFromDocumentId, handleDealTrigger, type TriggerResult, type TriggerTenantResolver
} from './trigger'

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
    const raw = Object.entries(v as Record<string, unknown>)
    // Кап на число ключей — до сверки токена мы разбираем недоверенное тело; длинный список
    // сортировать незачем (реальный document_id — 3 элемента).
    if (raw.length === 0 || raw.length > 20) return undefined
    const entries = raw.map(([k, val]) => [Number(k), val] as const).sort(([a], [b]) => a - b)
    // Симметрично ветке массива: любой непригодный элемент → отказ целиком, а не тихое выбрасывание
    // (иначе `{0:'crm',1:'DEAL_759',2:99}` дало бы усечённый путь и не тот элемент id).
    if (!entries.every(([k, val]) => Number.isInteger(k) && k >= 0 && typeof val === 'string')) return undefined
    return entries.map(([, val]) => val as string)
  }
  return undefined
}

/**
 * Полезная нагрузка робота. `document_id` — `['crm','CCrmDocumentDeal','DEAL_759']` (после нормализации
 * выше). Схема мягкая: лишние поля (`code`, `event_token`, `properties`, `ts`) не мешают.
 */
// Капы длины зеркалят схему событий (`deal-event.ts`): тело недоверенное и разбирается ДО сверки токена,
// поэтому многомегабайтный `member_id` не должен уезжать в SQL-параметр и в лог.
const robotEventSchema = z.object({
  document_id: z.preprocess(toStringArray, z.array(z.string().max(200)).min(1).max(10)),
  auth: z.object({
    member_id: z.string().min(1).max(200),
    application_token: z.string().min(1).max(253)
  })
})
export type RobotEvent = z.infer<typeof robotEventSchema>

/** Безопасно распарсить недоверенный POST робота → `RobotEvent` или `null` (мусор/неполнота). */
export function parseRobotEvent(raw: unknown): RobotEvent | null {
  const r = robotEventSchema.safeParse(raw)
  return r.success ? r.data : null
}

export type RobotOutcome =
  /**
   * Не наш/битый POST, `document_id` не про сделку либо портал исчез между сверкой токена и выбором
   * стора (`tenant`) — отвечаем 200, ничего не делаем.
   */
  | { kind: 'ignored'; reason: 'parse' | 'not_deal' | 'tenant' }
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
  /**
   * Стор и приглашения ПОРТАЛА события (#49) — по подтверждённому `member_id`, ПОСЛЕ сверки
   * `application_token`. См. {@link TriggerTenantResolver}.
   */
  tenant: TriggerTenantResolver
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

  // Токен сошёлся — `member_id` подтверждён, и только теперь выбирается тенант (#49).
  const tenant = await deps.tenant(ev.auth.member_id)
  if (!tenant) return { kind: 'ignored', reason: 'tenant' }

  const { deal, productRows } = await deps.fetchDeal(dealId, ev.auth.member_id)
  const context = dealToCrmContext(deal, productRows)
  // Ни проверки истории стадий, ни отсечения дублей: робот вызывается РОВНО на входе в стадию, то
  // есть один раз на переход. Гроздь событий рождает только событийный путь (`deal-update.ts`), где
  // апдейт сделки прилетает на каждую правку; здесь отсекать нечего, и ключа перехода взять неоткуда.
  const outcome = await handleDealTrigger({
    store: tenant.store,
    invitations: tenant.invitations,
    context,
    now: deps.now
  })
  return { kind: 'ok', results: outcome.created, dealId }
}
