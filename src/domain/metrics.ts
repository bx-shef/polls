/**
 * Детерминированные метрики (чистые функции). Версионно-нейтральны:
 * принимают массивы значений, ничего не знают про БД.
 */

export function round1(x: number): number {
  return Math.round(x * 10) / 10
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100
}

export interface NpsSummary {
  n: number
  promoters: number
  passives: number
  detractors: number
  /** NPS = %промоутеров − %детракторов, округлённый до 0.1. */
  nps: number
}

/** NPS по значениям 0..10: промоутеры ≥9, детракторы ≤6, пассивы 7–8. */
export function nps(values: number[]): NpsSummary {
  const n = values.length
  let promoters = 0
  let detractors = 0
  let passives = 0
  for (const v of values) {
    if (v >= 9) promoters++
    else if (v <= 6) detractors++
    else passives++
  }
  const score = n === 0 ? 0 : round1(((promoters - detractors) / n) * 100)
  return { n, promoters, passives, detractors, nps: score }
}

export interface CsatSummary {
  n: number
  mean: number
  /** Доля «топ-бокса» (оценок ≥ topBoxMin), %. */
  topBoxPct: number
}

/** CSAT: средняя оценка и доля топ-бокса (по умолчанию ≥4 по шкале 1–5). */
export function csat(values: number[], opts: { topBoxMin?: number } = {}): CsatSummary {
  const topBoxMin = opts.topBoxMin ?? 4
  const n = values.length
  if (n === 0) return { n: 0, mean: 0, topBoxPct: 0 }
  const sum = values.reduce((a, b) => a + b, 0)
  const top = values.filter((v) => v >= topBoxMin).length
  return { n, mean: round2(sum / n), topBoxPct: round1((top / n) * 100) }
}

/** Распределение выбранных вариантов (плоско по всем ответам). */
export function distribution(choices: string[][]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const arr of choices) {
    for (const key of arr) out[key] = (out[key] ?? 0) + 1
  }
  return out
}
