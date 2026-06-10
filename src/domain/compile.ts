import { surveyDraftSchema, type CompiledVersion, type SurveyDraft } from './schema'

/**
 * Компиляция черновика в иммутабельную версию + диагностика изменений
 * между версиями (решение «что делать, если вопросы меняются»).
 */

/** Валидирует и «замораживает» черновик в версию. Падает на дублях ключей. */
export function compile(draft: SurveyDraft, versionNo: number, at: Date = new Date()): CompiledVersion {
  const parsed = surveyDraftSchema.parse(draft)

  const qKeys = new Set<string>()
  for (const q of parsed.questions) {
    if (qKeys.has(q.key)) throw new Error(`Дублирующийся question_key: ${q.key}`)
    qKeys.add(q.key)
    const oKeys = new Set<string>()
    for (const o of q.options) {
      if (oKeys.has(o.key)) throw new Error(`Дублирующийся option_key «${o.key}» в вопросе ${q.key}`)
      oKeys.add(o.key)
    }
  }

  return {
    surveyKey: parsed.surveyKey,
    title: parsed.title,
    lang: parsed.lang,
    versionNo,
    questions: parsed.questions,
    compiledAt: at.toISOString()
  }
}

export type ChangeClass = 'unchanged' | 'text' | 'options' | 'semantic' | 'added' | 'removed'

/** Классы изменений, при которых временной ряд остаётся сопоставимым. */
export const COMPARABLE_CLASSES: ReadonlySet<ChangeClass> = new Set<ChangeClass>(['unchanged', 'text', 'options'])

export function isComparable(c: ChangeClass): boolean {
  return COMPARABLE_CLASSES.has(c)
}

/**
 * Сравнивает версии по question_key и классифицирует изменение каждого вопроса:
 * - `options` — изменился состав ключей вариантов (порядок не учитывается);
 * - `semantic` — сменилась метрика ИЛИ баллы (score) вариантов → ряд несопоставим;
 * - `text` — изменился только текст вопроса; `unchanged` — без изменений.
 */
export function diffVersions(a: CompiledVersion, b: CompiledVersion): Record<string, ChangeClass> {
  const am = new Map(a.questions.map((q) => [q.key, q]))
  const bm = new Map(b.questions.map((q) => [q.key, q]))
  const out: Record<string, ChangeClass> = {}

  for (const key of new Set([...am.keys(), ...bm.keys()])) {
    const qa = am.get(key)
    const qb = bm.get(key)
    if (qa && !qb) {
      out[key] = 'removed'
    } else if (!qa && qb) {
      out[key] = 'added'
    } else if (qa && qb) {
      if (qa.metric !== qb.metric) {
        out[key] = 'semantic'
      } else {
        // Состав ключей (без учёта порядка) — перестановка не ломает ряд.
        const keysA = qa.options.map((o) => o.key).sort().join(',')
        const keysB = qb.options.map((o) => o.key).sort().join(',')
        // Ключ+балл — ловит смену шкалы/score (это уже смена смысла).
        const sigA = qa.options.map((o) => `${o.key}=${o.score ?? ''}`).sort().join(',')
        const sigB = qb.options.map((o) => `${o.key}=${o.score ?? ''}`).sort().join(',')
        if (keysA !== keysB) out[key] = 'options'
        else if (sigA !== sigB) out[key] = 'semantic'
        else if (qa.text !== qb.text) out[key] = 'text'
        else out[key] = 'unchanged'
      }
    }
  }
  return out
}
