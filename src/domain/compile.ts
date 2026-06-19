import { surveyDraftSchema, type CompiledVersion, type SurveyDraft } from './schema'

/**
 * Компиляция черновика в иммутабельную версию + диагностика изменений
 * между версиями (решение «что делать, если вопросы меняются»).
 */

/** Валидирует и «замораживает» черновик в версию. Падает на `versionNo < 1` и дублях ключей. */
export function compile(draft: SurveyDraft, versionNo: number, at: Date = new Date()): CompiledVersion {
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw new Error(`versionNo должен быть положительным целым (получено: ${versionNo})`)
  }
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
    intro: parsed.intro,
    thanks: parsed.thanks,
    blocks: parsed.blocks,
    questions: parsed.questions,
    invitationPolicy: parsed.invitationPolicy,
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
 * - `semantic` — сменилась метрика, тип вопроса ИЛИ баллы (score) → ряд несопоставим;
 * - `text` — изменился только текст вопроса; `unchanged` — без изменений.
 * Смена только `label` варианта НЕ ломает сопоставимость (якорь — ключ) → `unchanged`.
 * Предполагает, что `a` и `b` — версии одного опроса (`surveyKey` не сверяется).
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
      if (qa.metric !== qb.metric || qa.type !== qb.type) {
        // Смена метрики ИЛИ типа вопроса (single↔multi↔text) ломает сопоставимость ряда.
        out[key] = 'semantic'
      } else {
        const keysA = qa.options.map((o) => o.key).sort().join(',')
        const keysB = qb.options.map((o) => o.key).sort().join(',')
        // Смена score у ПЕРЕСЕКАЮЩИХСЯ ключей = смена шкалы → semantic. Проверяем ДО
        // состава: иначе добавление/удаление варианта замаскировало бы смену балла.
        const bScore = new Map(qb.options.map((o) => [o.key, o.score ?? null]))
        const scaleShift = qa.options.some((o) => bScore.has(o.key) && bScore.get(o.key) !== (o.score ?? null))
        if (scaleShift) out[key] = 'semantic'
        else if (keysA !== keysB) out[key] = 'options'
        else if (qa.text !== qb.text) out[key] = 'text'
        else out[key] = 'unchanged'
      }
    }
  }
  return out
}
