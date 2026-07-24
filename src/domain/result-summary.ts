import type { CompiledVersion, Question, ResponseRecord, StoredAnswer } from './schema'

/**
 * Сводка одного завершённого ответа для показа менеджеру (триггер «клиент заполнил опрос»,
 * #18): пары «текст вопроса → значение ответа клиента», в порядке вопросов версии. Чистая
 * доменная логика (без CRM/бандла) — на выходе плоские строки, которые слой связки кладёт в
 * настраиваемое дело таймлайна (`bitrix24/activity.buildSurveyResultActivity`), а слой чтения —
 * в result-viewer (#18). НЕ агрегат: это ОДИН респондент (его баллы/выборы/текст), в отличие
 * от `aggregate.ts` (метрики по многим ответам).
 */

/** Строка сводки: метка (текст вопроса) + человекочитаемое значение ответа. */
export interface ResultLine {
  label: string
  value: string
}

export interface SummarizeOptions {
  /** Максимум строк (блоков активности 1..20 — оставляем запас). По умолчанию 15. */
  maxLines?: number
  /** Кап длины значения (защита от раздувания). По умолчанию 300. */
  maxValueLen?: number
}

/**
 * Человекочитаемое значение ОДНОГО ответа независимо от метрики: число (шкальные nps/csat/ces/scale) →
 * как есть (`!= null` — балл `0` валиден, не опускается); выбор (`valueChoice`) → метки вариантов через
 * `question.options` (fallback на ключ, если вариант удалён в новой версии), плюс свободный текст «Другое»
 * (`normalizeAnswer` кладёт его в `valueText` рядом с ключом опции); свободный текст → `valueText`.
 * Пустой/пропущенный ответ → `undefined` (строка не выводится — «вопрос пропущен» не шумит в таймлайне).
 */
function formatAnswerValue(question: Question, answer: StoredAnswer): string | undefined {
  if (answer.valueNumber != null) return String(answer.valueNumber)
  if (answer.valueChoice.length > 0) {
    const labels = new Map(question.options.map((o) => [o.key, o.label]))
    const chosen = answer.valueChoice.map((k) => labels.get(k) ?? k).join(', ')
    // «Другое»: normalizeAnswer кладёт свободный текст в valueText РЯДОМ с ключом опции в valueChoice —
    // дописываем его (самая ценная часть ответа-«Другое»), иначе в таймлайн уйдёт лишь метка «Другое».
    const other = answer.valueText?.trim()
    return other ? `${chosen}: ${other}` : chosen
  }
  const text = answer.valueText?.trim()
  return text ? text : undefined
}

/**
 * Свести ответ клиента к строкам «вопрос → значение» в порядке вопросов версии. Только отвеченные
 * вопросы (пустые пропускаем). Ограничено `maxLines`; значения обрезаны до `maxValueLen`. Сопоставление
 * идёт по стабильному `question_key` (версионно-безопасно, как агрегаты).
 */
export function summarizeResponse(
  version: CompiledVersion,
  response: ResponseRecord,
  opts: SummarizeOptions = {}
): ResultLine[] {
  const maxLines = opts.maxLines ?? 15
  const maxValueLen = opts.maxValueLen ?? 300
  // Первый ответ на question_key (дублей быть не должно, но берём устойчиво).
  const byKey = new Map<string, StoredAnswer>()
  for (const a of response.answers) if (!byKey.has(a.questionKey)) byKey.set(a.questionKey, a)

  const lines: ResultLine[] = []
  for (const q of version.questions) {
    if (lines.length >= maxLines) break
    const answer = byKey.get(q.key)
    if (!answer) continue
    const value = formatAnswerValue(q, answer)
    if (value === undefined) continue
    lines.push({ label: q.text, value: value.slice(0, maxValueLen) })
  }
  return lines
}
