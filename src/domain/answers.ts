import type { Question, RawAnswer, StoredAnswer } from './schema'

/**
 * Серверная нормализация и валидация ответов — аналог buildAnswers() прототипа,
 * но устойчивый к подделке: чужие/неизвестные ключи отбрасываются.
 */

const NUMERIC_METRICS = new Set(['nps', 'csat', 'ces', 'scale'])

function optionKeySet(q: Question): Set<string> {
  return new Set(q.options.map((o) => o.key))
}

function exclusiveKeySet(q: Question): Set<string> {
  return new Set(q.options.filter((o) => o.isExclusive).map((o) => o.key))
}

function otherKeySet(q: Question): Set<string> {
  return new Set(q.options.filter((o) => o.isOther).map((o) => o.key))
}

/** Исключающий вариант доминирует: если он выбран — остальные снимаются. */
export function coerceExclusive(q: Question, values: string[]): string[] {
  const excl = exclusiveKeySet(q)
  const chosenExclusive = values.find((v) => excl.has(v))
  return chosenExclusive ? [chosenExclusive] : values
}

/** Возвращает текст ошибки или null. Необязательные вопросы всегда валидны. */
export function validateAnswer(q: Question, raw: RawAnswer): string | null {
  if (q.type === 'text') {
    if (q.required && !(raw.text && raw.text.trim())) return 'Заполните поле'
    return null
  }
  const known = optionKeySet(q)
  const vals = (raw.values ?? []).filter((v) => known.has(v))
  if (q.required && vals.length === 0) {
    return q.type === 'multi' ? 'Выберите хотя бы один вариант' : 'Выберите вариант'
  }
  return null
}

/**
 * Нормализует сырой ответ в StoredAnswer или null (пустой/пропущенный).
 * Число берётся из option.score для шкальных метрик при одиночном выборе.
 */
export function normalizeAnswer(q: Question, raw: RawAnswer): StoredAnswer | null {
  if (q.type === 'text') {
    const text = raw.text?.trim() || null
    if (!text) return null
    return { questionKey: q.key, metric: q.metric, valueChoice: [], valueNumber: null, valueText: text }
  }

  const known = optionKeySet(q)
  let vals = (raw.values ?? []).filter((v) => known.has(v))
  vals = coerceExclusive(q, vals)
  if (q.type === 'single') vals = vals.slice(0, 1)
  if (vals.length === 0) return null

  let valueNumber: number | null = null
  if (NUMERIC_METRICS.has(q.metric) && vals.length === 1) {
    const opt = q.options.find((o) => o.key === vals[0])
    valueNumber = typeof opt?.score === 'number' ? opt.score : null
  }

  let valueText: string | null = null
  const others = otherKeySet(q)
  if (vals.some((v) => others.has(v)) && raw.text && raw.text.trim()) {
    valueText = raw.text.trim()
  }

  return { questionKey: q.key, metric: q.metric, valueChoice: vals, valueNumber, valueText }
}

export interface BuiltAnswers {
  answers: StoredAnswer[]
  errors: Record<string, string>
}

/** Строит набор ответов по версии опроса; собирает ошибки обязательных. */
export function buildResponseAnswers(
  questions: Question[],
  raw: Record<string, RawAnswer>
): BuiltAnswers {
  const answers: StoredAnswer[] = []
  const errors: Record<string, string> = {}
  for (const q of questions) {
    const a = raw[q.key] ?? {}
    const err = validateAnswer(q, a)
    if (err) {
      errors[q.key] = err
      continue
    }
    const norm = normalizeAnswer(q, a)
    if (norm) answers.push(norm)
  }
  return { answers, errors }
}
