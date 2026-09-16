import { Buffer } from 'node:buffer'
import type { SurveyTemplate } from './model'

/**
 * Validates what a respondent submitted against the template they were shown.
 *
 * Чистая функция: на вход шаблон и присланное, на выход — нормализованные ответы или список
 * претензий. Ни базы, ни сети. Проверять её можно вызовом, а не поднятым сервером, — а проверять
 * придётся много, потому что это единственное место между посторонним человеком и нашей базой.
 */

/**
 * Предел на один текстовый ответ, в БАЙТАХ.
 *
 * Байты, а не символы: кириллица в UTF-8 весит вдвое, и лимит в символах пустил бы вдвое
 * больше данных, чем рассчитано, — это правило проекта, а не придирка. Восемь килобайт — это
 * примерно четыре тысячи русских букв, заведомо больше самого развёрнутого ответа,
 * который встречался в разобранном наборе.
 */
export const MAX_TEXT_BYTES = 8 * 1024

/**
 * Предел на всю анкету, в байтах.
 *
 * Самая длинная анкета источника — 13 вопросов, из них текстовых не больше трёх. Развёрнутый
 * ответ в разобранном наборе — сотни байт, так что честному респонденту этих 64 КБ хватает
 * с запасом в сотни раз. Предел нужен не от него, а от того, кто пришёл с готовым телом
 * на сто мегабайт: предел на одно поле такого не ловит, если полей много.
 */
export const MAX_TOTAL_BYTES = 64 * 1024

/**
 * Значение одного ответа.
 *
 * ⚠ `null` — это «не ответил», и он НЕ равен нулю. Балльный вопрос не имеет предустановленного
 * значения: нетронутый ползунок уезжает как `null`, иначе отличить пропуск от честной оценки
 * станет невозможно навсегда. Ровно это и случилось у заказчика: «поставил ноль» и «не тронул»
 * в его данных одно и то же значение, и починить это уже нельзя.
 */
export type AnswerValue = number | string | null

export interface AnswerProblem {
  /** Ключ вопроса; пусто — претензия ко всей анкете, а не к одному ответу. */
  key: string
  code: 'unknown-question' | 'not-a-number' | 'out-of-range' | 'not-a-string' | 'too-long' | 'too-large'
  detail: string
}

export type AnswerCheck
  = | { ok: true, answers: Record<string, AnswerValue> }
    | { ok: false, problems: AnswerProblem[] }

/**
 * Проверить и нормализовать присланные ответы.
 *
 * Пропущенные вопросы — не ошибка: их значение `null`. Обязательность в модели опроса
 * пока не описана, и выдумывать её здесь нельзя — отказ по несуществующему правилу
 * выглядел бы для человека поломкой сайта.
 *
 * Лишние ключи, наоборот, отвергаются: ответ на вопрос, которого в шаблоне нет, — это либо
 * подделанная форма, либо шаблон, подменившийся между показом и отправкой. Тихо выбросить
 * такой ключ значило бы записать в портал неполный ответ под видом полного.
 */
export function checkAnswers(template: SurveyTemplate, submitted: unknown): AnswerCheck {
  const problems: AnswerProblem[] = []

  if (submitted === null || typeof submitted !== 'object' || Array.isArray(submitted)) {
    return { ok: false, problems: [{ key: '', code: 'unknown-question', detail: 'ответы должны быть объектом' }] }
  }

  const raw = submitted as Record<string, unknown>
  const questions = new Map(template.sections.flatMap(s => s.questions).map(q => [q.key, q]))
  const answers: Record<string, AnswerValue> = {}
  let totalBytes = 0

  for (const key of Object.keys(raw)) {
    if (!questions.has(key)) {
      problems.push({ key, code: 'unknown-question', detail: 'такого вопроса в анкете нет' })
    }
  }

  for (const [key, question] of questions) {
    const value = raw[key]
    // ⚠ Строка из одних пробелов — тоже пропуск. Без `trim` она дошла бы до балльного
    // вопроса, где `Number(' ')` даёт ноль, и пропуск молча превратился бы в честную
    // нулевую оценку — ровно та путаница, ради которой весь файл и написан.
    const blank = value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '')
    if (blank) {
      // Пустое текстовое поле — это пропуск, а не ответ длиной ноль:
      // хранить их по-разному не за чем.
      answers[key] = null
      continue
    }

    if (question.type === 'scale') {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (typeof value !== 'number' && typeof value !== 'string') {
        problems.push({ key, code: 'not-a-number', detail: 'оценка должна быть числом' })
        continue
      }
      if (!Number.isFinite(numeric)) {
        problems.push({ key, code: 'not-a-number', detail: 'оценка должна быть числом' })
        continue
      }
      const min = question.scale?.min ?? 0
      const max = question.scale?.max ?? 10
      if (numeric < min || numeric > max) {
        problems.push({ key, code: 'out-of-range', detail: `оценка вне шкалы ${min}–${max}` })
        continue
      }
      answers[key] = numeric
      continue
    }

    if (typeof value !== 'string') {
      problems.push({ key, code: 'not-a-string', detail: 'ответ должен быть текстом' })
      continue
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_TEXT_BYTES) {
      problems.push({ key, code: 'too-long', detail: `ответ длиннее ${MAX_TEXT_BYTES} байт` })
      continue
    }
    totalBytes += bytes
    answers[key] = value
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    problems.push({ key: '', code: 'too-large', detail: `анкета целиком длиннее ${MAX_TOTAL_BYTES} байт` })
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, answers }
}
