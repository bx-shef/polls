import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { crmContextSchema, type CrmContext } from '../domain/schema'

/**
 * Триггер-биндинг ONCRMDEALUPDATE (ISSUE #17) — ЯДРО-рантайм, без HTTP/портала.
 *
 * Поток (полностью — см. docs/bitrix24-integration.md): портал POST'ит событие на наш
 * публичный эндпоинт → НЕДОВЕРЕННО (его может подделать кто угодно). Безопасность:
 *  1. Событие несёт только `data.FIELDS.ID` сделки + `auth` (member_id/domain/токены) —
 *     `parseDealUpdateEvent` мягко парсит недоверенный POST.
 *  2. `auth.application_token` — секрет «приложение↔портал», выданный при установке:
 *     `verifyApplicationToken` сверяет его (constant-time) с сохранённым для портала —
 *     анти-форджери (без этого любой мог бы инициировать рассылку приглашений).
 *  3. Полные поля сделки (стадия/контакт/ответственный) события НЕ содержат — их догружает
 *     binding-слой через `crm.deal.get(ID)` и мапит в `CrmContext` (`dealToCrmContext`).
 *
 * Эндпоинт + регистрация обработчика (`event.bind`) + хранение `application_token` при установке
 * + догрузка сделки токеном портала + создание приглашений — слой связки (нужен живой портал, #17).
 */

/** Недоверенный POST ONCRMDEALUPDATE (минимум для нас; прочие поля игнорируются). */
export const dealUpdateEventSchema = z.object({
  // Битрикс шлёт верхним регистром; сверяем регистронезависимо (маршрут — наш контракт).
  event: z.string().refine((s) => s.toUpperCase() === 'ONCRMDEALUPDATE', 'не ONCRMDEALUPDATE'),
  data: z.object({
    FIELDS: z.object({ ID: z.coerce.number().int().positive() })
  }),
  // Токены не всегда передаются (если хит не привязан к пользователю) — без auth доверять нечему.
  auth: z.object({
    member_id: z.string().min(1).max(200),
    domain: z.string().min(1).max(253),
    application_token: z.string().min(1).max(200),
    access_token: z.string().min(1).max(4096).optional()
  })
})
export type DealUpdateEvent = z.infer<typeof dealUpdateEventSchema>

/** Безопасно распарсить недоверенный POST события → `DealUpdateEvent` или `null` (мусор/неполнота). */
export function parseDealUpdateEvent(raw: unknown): DealUpdateEvent | null {
  const r = dealUpdateEventSchema.safeParse(raw)
  return r.success ? r.data : null
}

/**
 * Сверка `application_token` события с сохранённым для портала (анти-форджери), constant-time.
 * Пустой любой из токенов → отказ (fail-closed: без секрета событие не доверяем).
 */
export function verifyApplicationToken(received: string, expected: string): boolean {
  if (!received || !expected) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Число из REST-значения (строки/числа); пусто/NaN → undefined. Общий хелпер мапперов сущностей. */
export function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
/** Положительный id (0/пусто = «нет связи» → undefined). */
export function posId(v: unknown): number | undefined {
  const n = num(v)
  return n && n > 0 ? n : undefined
}

/**
 * Товарные позиции сделки (`crm.deal.productrows.get`) → `products` снимка `CrmContext`. Каждая строка —
 * `PRODUCT_ID` (положительный; 0/пусто = не товар → отбрасываем) + `PRODUCT_NAME` (денормализованное имя,
 * опционально). Питает срез дашборда «услуга/товар» (`byProduct`). Пустой вход → пустой массив.
 * Живой формат сверен вебхуком (`PRODUCT_ID`/`PRODUCT_NAME`, crm.deal.productrows.get).
 */
export function mapProductRows(rows: Array<Record<string, unknown>>): Array<{ productId: number; productName?: string }> {
  const out: Array<{ productId: number; productName?: string }> = []
  for (const r of rows) {
    const productId = posId(r.PRODUCT_ID)
    if (productId === undefined) continue // 0/пусто/мусор → не товар
    const productName = typeof r.PRODUCT_NAME === 'string' && r.PRODUCT_NAME !== '' ? r.PRODUCT_NAME : undefined
    out.push(productName !== undefined ? { productId, productName } : { productId })
  }
  return out
}

/**
 * Маппинг ответа `crm.deal.get` (+ опц. товарных позиций `crm.deal.productrows.get`) → снимок `CrmContext`
 * (#17). Берёт IDs + стадию + `products`; денормализованные ИМЕНА company/category/responsible — отдельным
 * обогащением (crm.company/category/user.get), до него срезы дашборда падают на ID. `productRows` (по
 * умолчанию пусто) обогащает срез «услуга/товар»: без них `byProduct` пуст на реальных данных (сверено
 * вебхуком — прод-путь их не тянул). Результат валидируется схемой (устойчивость к мусору CRM).
 */
export function dealToCrmContext(
  deal: Record<string, unknown>,
  productRows: Array<Record<string, unknown>> = []
): CrmContext {
  const products = mapProductRows(productRows)
  return crmContextSchema.parse({
    dealId: posId(deal.ID),
    dealCategoryId: num(deal.CATEGORY_ID),
    dealStageId: typeof deal.STAGE_ID === 'string' ? deal.STAGE_ID : undefined,
    companyId: posId(deal.COMPANY_ID),
    contactId: posId(deal.CONTACT_ID),
    responsibleId: posId(deal.ASSIGNED_BY_ID),
    dealAmount: num(deal.OPPORTUNITY),
    // Пустой products не кладём — снимок чище, схема поле опускает (`.optional()`).
    ...(products.length ? { products } : {})
  })
}
