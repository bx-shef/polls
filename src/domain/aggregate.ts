import type { ResponseRecord } from './schema'
import { ces, csat, distribution, nps, type CesSummary, type CsatSummary, type NpsSummary } from './metrics'

/**
 * Агрегация поверх массива ответов. Версионно-безопасна: значения собираются
 * по стабильному question_key, а не по тексту или номеру версии.
 */

/** Минимальный размер выборки для чувствительных срезов (анонимность/значимость). */
export const ANONYMITY_THRESHOLD = 5

/**
 * Достаточна ли выборка, чтобы показать срез без риска деанонимизации.
 * ВНИМАНИЕ: фильтры и метрики ниже — «сырые» building-blocks и НЕ подавляют
 * малые N сами по себе. Принудительное подавление на срезах (компания/продукт/
 * направление), пагинация и tenant-изоляция (portalId) — ответственность слоя
 * чтения/дашборда (PgStore + read-API, ISSUE #7).
 */
export function meetsAnonymity(n: number, threshold: number = ANONYMITY_THRESHOLD): boolean {
  return n >= threshold
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, val: V): void {
  const arr = map.get(key)
  if (arr) arr.push(val)
  else map.set(key, [val])
}

function bucketKey(iso: string, bucket: 'month' | 'day'): string {
  // Нормализуем к UTC: offset (напр. +05:00) не должен смещать день/месяц через полночь.
  const utc = new Date(iso).toISOString()
  return bucket === 'month' ? utc.slice(0, 7) : utc.slice(0, 10)
}

/** Числовые значения вопроса по всем ответам (для nps/csat/...). */
export function numericValues(rs: ResponseRecord[], questionKey: string): number[] {
  const out: number[] = []
  for (const r of rs) {
    for (const a of r.answers) {
      if (a.questionKey === questionKey && a.valueNumber != null) out.push(a.valueNumber)
    }
  }
  return out
}

/** Наборы выбранных вариантов вопроса по всем ответам (для распределения). */
export function choiceValues(rs: ResponseRecord[], questionKey: string): string[][] {
  const out: string[][] = []
  for (const r of rs) {
    for (const a of r.answers) {
      if (a.questionKey === questionKey && a.valueChoice.length > 0) out.push(a.valueChoice)
    }
  }
  return out
}

// ── Фильтры под 4 уровня агрегации ──
// ВНИМАНИЕ: сырые срезы НЕ подавляют малые N. Перед показом byCompany/byCategory/
// byProduct проверяйте размер выборки через meetsAnonymity (риск деанонимизации).
export const bySurvey = (rs: ResponseRecord[], surveyKey: string): ResponseRecord[] =>
  rs.filter((r) => r.surveyKey === surveyKey)

export const byCompany = (rs: ResponseRecord[], companyId: number): ResponseRecord[] =>
  rs.filter((r) => r.context.companyId === companyId)

export const byCategory = (rs: ResponseRecord[], categoryId: number): ResponseRecord[] =>
  rs.filter((r) => r.context.dealCategoryId === categoryId)

export const byProduct = (rs: ResponseRecord[], productId: number): ResponseRecord[] =>
  rs.filter((r) => (r.context.products ?? []).some((p) => p.productId === productId))

/** Срез по конкретной версии. */
export const byVersion = (rs: ResponseRecord[], versionNo: number): ResponseRecord[] =>
  rs.filter((r) => r.versionNo === versionNo)

/** Срез по диапазону версий [fromVersion, toVersion] — для сравнения «до/после публикации». */
export const byVersionRange = (rs: ResponseRecord[], fromVersion: number, toVersion: number): ResponseRecord[] =>
  rs.filter((r) => r.versionNo >= fromVersion && r.versionNo <= toVersion)

// ── Метрики по подвыборке ──
export const npsFor = (rs: ResponseRecord[], questionKey: string): NpsSummary =>
  nps(numericValues(rs, questionKey))

export const csatFor = (
  rs: ResponseRecord[],
  questionKey: string,
  opts?: { topBoxMin?: number }
): CsatSummary => csat(numericValues(rs, questionKey), opts)

export const cesFor = (rs: ResponseRecord[], questionKey: string): CesSummary =>
  ces(numericValues(rs, questionKey))

export const distributionFor = (rs: ResponseRecord[], questionKey: string): Record<string, number> =>
  distribution(choiceValues(rs, questionKey))

export interface ResponsibleKpi {
  responsibleId: number
  summary: NpsSummary
}

/** KPI сотрудников: NPS по ответственному с порогом значимости/анонимности. Результат отсортирован по убыванию NPS. */
export function kpiByResponsible(
  rs: ResponseRecord[],
  questionKey: string,
  opts: { minN?: number } = {}
): ResponsibleKpi[] {
  const minN = opts.minN ?? ANONYMITY_THRESHOLD
  const groups = new Map<number, ResponseRecord[]>()
  for (const r of rs) {
    const id = r.context.responsibleId
    if (id == null) continue
    pushTo(groups, id, r)
  }
  const out: ResponsibleKpi[] = []
  for (const [responsibleId, list] of groups) {
    const summary = npsFor(list, questionKey)
    if (meetsAnonymity(summary.n, minN)) out.push({ responsibleId, summary })
  }
  return out.sort((a, b) => b.summary.nps - a.summary.nps)
}

export interface TrendPoint extends NpsSummary {
  bucket: string
}

/**
 * Динамика NPS по периодам (версионно-безопасно — по question_key).
 * Бакеты — UTC: `YYYY-MM` / `YYYY-MM-DD`. `minN` подавляет точки с малой выборкой
 * (по умолчанию 1 — без подавления; для анонимности передайте `ANONYMITY_THRESHOLD`).
 */
export function npsTrend(
  rs: ResponseRecord[],
  questionKey: string,
  bucket: 'month' | 'day' = 'month',
  minN = 1
): TrendPoint[] {
  const groups = new Map<string, number[]>()
  for (const r of rs) {
    for (const a of r.answers) {
      if (a.questionKey === questionKey && a.valueNumber != null) {
        pushTo(groups, bucketKey(r.submittedAt, bucket), a.valueNumber)
      }
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([b, vals]) => ({ bucket: b, ...nps(vals) }))
    .filter((p) => p.n >= minN)
}
