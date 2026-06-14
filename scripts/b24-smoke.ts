/**
 * Живой smoke-тест интеграции с Bitrix24 (фаза связки). Через INBOUND-вебхук
 * (env `B24_WEBHOOK_URL`) читает реальную сделку портала и проверяет, что её
 * CRM-контекст КОРРЕКТНО маппится в `CrmContext` ядра (zod-валидация). Только ЧТЕНИЕ.
 *
 * Запуск:
 *   B24_WEBHOOK_URL='https://<portal>/rest/<id>/<token>/' pnpm exec tsx scripts/b24-smoke.ts
 *
 * Домен/токен портала НЕ коммитим (портал ротируется ежемесячно) — только env.
 * Скрипт не делает записей в CRM; печатает идентификаторы и имена товаров, но не
 * тянет ПДн контактов (имя/телефон/email).
 */
import { crmContextSchema, type CrmContext } from '../src/domain/schema'

const base = process.env['B24_WEBHOOK_URL']?.replace(/\/?$/, '/') // гарантируем хвостовой '/'
if (!base) {
  console.error("Нет B24_WEBHOOK_URL. Пример: B24_WEBHOOK_URL='https://<portal>/rest/<id>/<token>/' pnpm exec tsx scripts/b24-smoke.ts")
  process.exit(1)
}

type B24Resp<T> = { result?: T; error?: string; error_description?: string }

/** POST-вызов REST-метода вебхука. Бросает при ошибке Bitrix24. */
async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${base}${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  })
  const json = (await res.json()) as B24Resp<T>
  if (json.error) throw new Error(`${method}: ${json.error} ${json.error_description ?? ''}`.trim())
  return json.result as T
}

/** Bitrix24 отдаёт числовые поля строками — приводим к number|undefined. */
const num = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

async function main(): Promise<void> {
  // 1) целевая сделка: по B24_DEAL_ID (crm.deal.get) либо последняя (crm.deal.list)
  const wantId = num(process.env['B24_DEAL_ID'])
  let deal: Record<string, unknown>
  if (wantId !== undefined) {
    deal = await call<Record<string, unknown>>('crm.deal.get', { id: wantId })
    if (!deal || num(deal['ID']) === undefined) {
      console.log(`Сделка ${wantId} не найдена на портале.`)
      return
    }
  } else {
    const deals = await call<Array<Record<string, unknown>>>('crm.deal.list', {
      order: { ID: 'DESC' },
      select: ['ID', 'CATEGORY_ID', 'STAGE_ID', 'COMPANY_ID', 'CONTACT_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY']
    })
    if (!deals.length) {
      console.log('На портале нет сделок. Создай тестовую сделку (с компанией, контактом и товаром) и повтори.')
      return
    }
    deal = deals[0]!
  }
  const dealId = num(deal['ID'])!

  // 2) товарные позиции сделки (best-effort — может не быть товаров)
  let rows: Array<Record<string, unknown>> = []
  try {
    rows = await call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId })
  } catch (e) {
    console.warn('crm.deal.productrows.get не сработал:', e instanceof Error ? e.message : e)
  }

  // 3) собираем CrmContext ядра из реальных полей Bitrix24
  const ctx: CrmContext = {
    dealId,
    dealCategoryId: num(deal['CATEGORY_ID']),
    dealStageId: str(deal['STAGE_ID']),
    companyId: num(deal['COMPANY_ID']),
    contactId: num(deal['CONTACT_ID']),
    responsibleId: num(deal['ASSIGNED_BY_ID']),
    dealAmount: num(deal['OPPORTUNITY']),
    products: rows
      .map((r) => ({ productId: num(r['PRODUCT_ID']), productName: str(r['PRODUCT_NAME']) }))
      .filter((p): p is { productId: number; productName: string | undefined } => p.productId !== undefined)
  }
  // отбрасываем undefined-поля и пустой products — как делал бы invitation-flow
  const cleaned = Object.fromEntries(
    Object.entries(ctx).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
  )

  // 4) валидация против схемы ядра — это и есть проверка интеграции
  const parsed = crmContextSchema.safeParse(cleaned)

  console.log('─ Bitrix24 → CrmContext ─')
  console.log(JSON.stringify(cleaned, null, 2))
  console.log(`Сделка: ${dealId}; товарных позиций: ${ctx.products?.length ?? 0}`)
  if (parsed.success) {
    console.log('✓ CrmContext ВАЛИДЕН по zod-схеме ядра — маппинг сходится.')
  } else {
    console.log('✗ Расхождение со схемой ядра:')
    console.log(JSON.stringify(parsed.error.issues, null, 2))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('Сбой smoke-теста:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
