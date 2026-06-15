/**
 * Живой smoke-тест интеграции с Bitrix24 (фаза связки). Через INBOUND-вебхук
 * (env `B24_WEBHOOK_URL`) читает реальные сделки портала и проверяет весь путь
 * связки: deal → `CrmContext` ядра → `ResponseRecord` → 4-уровневая агрегация.
 * Только ЧТЕНИЕ; записей в CRM не делает.
 *
 * Секции:
 *   A) целевая сделка (`B24_DEAL_ID`) → CrmContext + zod-валидация;
 *   B) резолвинг связанных компании/контакта + наличие каналов (email/phone) под #3;
 *   C) батч последних N сделок (`B24_DEAL_LIMIT`, по умолч. 10) — робастность маппинга;
 *   D) агрегация ядра (byCompany/byCategory/byProduct/kpiByResponsible) на РЕАЛЬНОМ
 *      контексте — NPS-ответы синтетические и детерминированные (живых ответов пока нет).
 *
 * Запуск:
 *   B24_WEBHOOK_URL='https://<portal>/rest/<id>/<token>/' pnpm exec tsx scripts/b24-smoke.ts
 *
 * Домен/токен портала НЕ коммитим (портал ротируется ежемесячно) — только env.
 * ПДн контактов (имя/телефон/email) не печатаем — только факт наличия (boolean).
 */
import {
  crmContextSchema,
  responseRecordSchema,
  type CrmContext,
  type ResponseRecord,
  type StoredAnswer
} from '../src/domain/schema'
import { byCategory, byCompany, byProduct, kpiByResponsible, npsFor } from '../src/domain/aggregate'

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

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** Bitrix24 отдаёт числовые поля строками — приводим к number|undefined. */
const num = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** Наиболее частое непустое значение (для выбора доминирующего среза). */
function mode<T>(xs: Array<T | undefined>): T | undefined {
  const counts = new Map<T, number>()
  for (const x of xs) if (x !== undefined) counts.set(x, (counts.get(x) ?? 0) + 1)
  let best: T | undefined
  let bestN = 0
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n]
  return best
}

/** Чистый маппинг полей сделки Bitrix24 → CrmContext ядра. */
function mapDeal(deal: Record<string, unknown>, rows: Array<Record<string, unknown>>): CrmContext {
  return {
    dealId: num(deal['ID']),
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
}

/** Убираем undefined-поля и пустой products — для чистого вывода/валидации. */
function clean(ctx: CrmContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ctx).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
  )
}

/** Товарные позиции сделки (best-effort — товаров может не быть). */
async function fetchRows(dealId: number): Promise<Array<Record<string, unknown>>> {
  try {
    return await call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId })
  } catch (e) {
    console.warn(`  crm.deal.productrows.get(${dealId}): ${msg(e)}`)
    return []
  }
}

/** Резолвинг связанных компании/контакта + наличие каналов связи (без ПДн-значений). */
async function checkResolve(ctx: CrmContext): Promise<void> {
  if (ctx.companyId != null) {
    try {
      const c = await call<Record<string, unknown>>('crm.company.get', { id: ctx.companyId })
      console.log(`  компания ${ctx.companyId}: резолвится ${num(c['ID']) != null ? '✓' : '✗'} (TITLE ${str(c['TITLE']) ? 'есть' : 'нет'})`)
    } catch (e) {
      console.log(`  компания ${ctx.companyId}: ошибка — ${msg(e)}`)
    }
  }
  if (ctx.contactId != null) {
    try {
      const c = await call<Record<string, unknown>>('crm.contact.get', { id: ctx.contactId })
      const hasEmail = Array.isArray(c['EMAIL']) && (c['EMAIL'] as unknown[]).length > 0
      const hasPhone = Array.isArray(c['PHONE']) && (c['PHONE'] as unknown[]).length > 0
      console.log(`  контакт ${ctx.contactId}: резолвится ${num(c['ID']) != null ? '✓' : '✗'} — EMAIL: ${hasEmail ? 'есть' : 'нет'}, PHONE: ${hasPhone ? 'есть' : 'нет'} (каналы приглашения #3)`)
    } catch (e) {
      console.log(`  контакт ${ctx.contactId}: ошибка — ${msg(e)}`)
    }
  }
}

const QKEY = 'nps_demo'
/** Синтетический, но детерминированный ResponseRecord поверх РЕАЛЬНОГО контекста. */
function syntheticRecord(ctx: CrmContext, i: number): ResponseRecord {
  const answer: StoredAnswer = {
    questionKey: QKEY,
    metric: 'nps',
    valueChoice: [],
    valueNumber: (ctx.dealId ?? i) % 11, // 0..10 детерминированно
    valueText: null
  }
  return {
    id: `smoke-${ctx.dealId ?? i}`,
    surveyKey: 'b24-smoke-synthetic',
    versionNo: 1,
    submittedAt: new Date().toISOString(),
    context: ctx,
    answers: [answer]
  }
}

async function main(): Promise<void> {
  const limit = num(process.env['B24_DEAL_LIMIT']) ?? 10
  const wantId = num(process.env['B24_DEAL_ID'])

  // ── A) целевая сделка → CrmContext (детальный showcase) ──
  let target: CrmContext | undefined
  if (wantId !== undefined) {
    const deal = await call<Record<string, unknown>>('crm.deal.get', { id: wantId })
    if (deal && num(deal['ID']) != null) target = mapDeal(deal, await fetchRows(wantId))
    else console.log(`Сделка ${wantId} не найдена на портале.`)
  }
  if (target) {
    console.log('─ A) Bitrix24 → CrmContext (целевая сделка) ─')
    const cleaned = clean(target)
    // dealAmount (сумма сделки — финданные) маскируем в выводе: stdout может уходить в лог/CI.
    const shown: Record<string, unknown> = { ...cleaned }
    if (shown['dealAmount'] != null) shown['dealAmount'] = '<скрыто>'
    console.log(JSON.stringify(shown, null, 2))
    const parsed = crmContextSchema.safeParse(cleaned)
    if (parsed.success) console.log('✓ CrmContext валиден по zod-схеме ядра — маппинг сходится.')
    else {
      console.log('✗ Расхождение со схемой:', JSON.stringify(parsed.error.issues))
      process.exitCode = 1
    }
    // ── B) резолвинг компании/контакта + каналы под invitation-flow #3 ──
    console.log('─ B) Резолвинг связанных сущностей ─')
    await checkResolve(target)
  }

  // ── C) батч последних N сделок → маппинг + валидация (робастность) ──
  console.log(`─ C) Батч последних ${limit} сделок ─`)
  const deals = await call<Array<Record<string, unknown>>>('crm.deal.list', {
    order: { ID: 'DESC' },
    select: ['ID', 'CATEGORY_ID', 'STAGE_ID', 'COMPANY_ID', 'CONTACT_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY'],
    start: 0
  })
  const batch = deals.slice(0, limit)
  const contexts: CrmContext[] = []
  let valid = 0
  for (const d of batch) {
    const id = num(d['ID'])
    if (id == null) {
      console.log('  ⚠ сделка без ID — пропущена')
      continue
    }
    const ctx = mapDeal(d, await fetchRows(id))
    if (crmContextSchema.safeParse(clean(ctx)).success) valid++
    else console.log(`  ⚠ сделка ${id}: контекст не прошёл схему`)
    contexts.push(ctx)
  }
  console.log(`  сопоставлено ${batch.length}; валидны по схеме CrmContext: ${valid}/${batch.length}`)

  // ── D) агрегация ядра на РЕАЛЬНОМ контексте (NPS-ответы синтетические) ──
  console.log('─ D) Агрегация ядра на реальном CRM-контексте (NPS-ответы синтетические) ─')
  const records: ResponseRecord[] = contexts.map(syntheticRecord)
  const recValid = records.filter((r) => responseRecordSchema.safeParse(r).success).length
  console.log(`  ResponseRecord собрано: ${records.length}; валидны по схеме: ${recValid}/${records.length}`)
  const companyId = mode(contexts.map((c) => c.companyId))
  const categoryId = mode(contexts.map((c) => c.dealCategoryId))
  const productId = mode(contexts.flatMap((c) => (c.products ?? []).map((p) => p.productId)))
  if (companyId != null) {
    const s = byCompany(records, companyId)
    console.log(`  клиент      (companyId=${companyId}): n=${s.length} → NPS ${npsFor(s, QKEY).nps}`)
  }
  if (categoryId != null) {
    const s = byCategory(records, categoryId)
    console.log(`  направление (CATEGORY_ID=${categoryId}): n=${s.length} → NPS ${npsFor(s, QKEY).nps}`)
  }
  if (productId != null) {
    const s = byProduct(records, productId)
    console.log(`  услуга      (productId=${productId}): n=${s.length} → NPS ${npsFor(s, QKEY).nps}`)
  }
  const kpi = kpiByResponsible(records, QKEY, { minN: 1 })
  console.log(`  KPI ответственных: ${kpi.map((k) => `#${k.responsibleId}→NPS ${k.summary.nps}(n=${k.summary.n})`).join(', ') || '—'}`)
  console.log('✓ Путь связки пройден: deal → CrmContext → ResponseRecord → 4-уровневая агрегация.')
}

main().catch((e) => {
  console.error('Сбой smoke-теста:', msg(e))
  process.exitCode = 1
})
