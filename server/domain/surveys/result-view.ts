import { formatScore } from '../../../shared/score-format'
import type { SurveyTemplate } from './model'

/**
 * The survey result as the card widget shows it: questions in words, answers as text.
 *
 * Чистые функции: на вход — схема версии и два поля элемента «Опрос» (`ANSWERS`, `SCORES`),
 * на выход — готовые к показу строки. Ни базы, ни сети. Разбор здесь, а не в обработчике
 * запроса, потому что именно тут живут ловушки, которые проект уже оплачивал: `null` против
 * нуля и числа, приехавшие строкой.
 *
 * ⚠ ЭТО ОТВЕТЫ ПОСТОРОННЕГО ЧЕЛОВЕКА. Функции ничего не пишут в журнал и не должны начинать:
 * запрет «не логировать текст ответа клиента» действует и в отладке, и временно.
 */

/** Один ответ в виджете. */
export interface ResultAnswer {
  key: string
  title: string
  /** Готовый к показу текст. Пропуск — прочерк, а не пустота и не ноль. */
  value: string
  /** «из 10» у балльного вопроса; пусто у остальных. */
  scale: string
}

/** Раздел анкеты в виджете. */
export interface ResultSection {
  key: string
  title: string
  /** Балл раздела по-русски («7,5»); пусто — раздел балла не даёт или не оценён. */
  score: string
  /** «ответ на 1 из 5, пропуск — низшая оценка» у неполного балла, «без оценки» у раздела без балла; пусто у остальных. */
  note: string
  answers: ResultAnswer[]
}

/** Балл раздела из поля `SCORES`: сам балл, на сколько балльных вопросов ответили и сколько их всего. */
export interface SectionScoreRow {
  score: number | null
  answered: number
  scored: number
}

/**
 * Подпись балльного раздела, у которого балла нет.
 *
 * ⚠ Нейтральная, без «почему»: причин у пустого балла три, и назвать одну значило бы соврать
 * про остальные. (1) Прохождение записано до 28.09 — тогда раздел без единого ответа балла
 * не получал; теперь пропуск входит низшей оценкой (`scoring.ts`), но старые записи
 * не пересчитывали: на порталах были только тестовые. (2) Раздел помечен балльным, а балльных
 * вопросов в оценку в нём нет — публикация такое не пропускает, но перенесённые анкеты
 * опубликованы операторской командой мимо неё. (3) Поле `SCORES` испорчено или пусто — его
 * до #84 можно было править руками в карточке. Прежний текст «ни один вопрос не заполнен»
 * был правдой только для первой. Нашёл `/review` в PR #85.
 *
 * ⚠ Общая с делом в ленте сделки (`server/domain/answers/comment.ts`): одно прохождение
 * показывается в двух местах, и расходиться словами они не должны. Нашли `/review`
 * и `/code-review` в PR #80.
 */
export const NO_SCORE_NOTE = 'без оценки'

// Запись балла — общая со страницами (`shared/score-format.ts`): вкладка сделки показывает тот же балл.
export { formatScore }

/**
 * Неполнота балла словами: «ответ на 2 из 5, пропуск — низшая оценка». Пусто, если ответили на всё.
 *
 * ⚠ Пропуск входит в балл низшей оценкой (`scoring.ts`, решение владельца 28.09), и балл
 * с пропусками занижен намеренно. Без этой подписи менеджер не отличит «клиент недоволен»
 * от «клиент не ответил»: цифра одна и та же. Прежняя подпись «по 2 из 5 вопросов» говорила
 * о другом правиле — балл тогда считался только по отвеченным. Общая с лентой сделки.
 */
export function partialScoreNote(answered: number, scored: number): string {
  return answered < scored ? `ответ на ${answered} из ${scored}, пропуск — низшая оценка` : ''
}

/** Прочерк на месте пропущенного ответа. */
export const NO_ANSWER = '—'

/**
 * Разобрать поле `ANSWERS`: JSON-объект «ключ вопроса → значение».
 *
 * `null` — ответов нет: приглашение ещё не прошли либо в поле лежит не объект. Для виджета
 * оба случая значат одно — показывать нечего, и это не ошибка.
 */
export function readAnswersField(raw: unknown): Record<string, unknown> | null {
  const parsed = parseJson(raw)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
}

/** Разобрать поле `SCORES`: баллы разделов по ключу раздела. Нечитаемые строки пропускаются. */
export function readScoresField(raw: unknown): Map<string, SectionScoreRow> {
  const parsed = parseJson(raw)
  const scores = new Map<string, SectionScoreRow>()
  if (!Array.isArray(parsed)) return scores

  for (const row of parsed as { key?: unknown, score?: unknown, answered?: unknown, scored?: unknown }[]) {
    if (typeof row?.key !== 'string') continue
    scores.set(row.key, { score: asScore(row.score), answered: count(row.answered), scored: count(row.scored) })
  }
  return scores
}

/**
 * Разделы результата: с формулировками, если схема версии нашлась, и с ключами, если нет.
 *
 * ⚠ Без схемы показываем ЧТО ЕСТЬ, а не пустоту. Ключ вопроса человеку мало что скажет,
 * но «ответ был» он покажет, и это лучше экрана, по которому нельзя понять, есть ли данные
 * вообще. Схема неизменяема и лежит на портале, так что этот случай — редкость, а не норма.
 */
export function buildResultSections(
  template: SurveyTemplate | null,
  answers: Record<string, unknown>,
  scores: Map<string, SectionScoreRow>,
): ResultSection[] {
  if (template === null) {
    return [{
      key: '',
      title: 'Ответы',
      score: '',
      note: '',
      answers: Object.entries(answers).map(([key, value]) => ({ key, title: key, value: showAnswer(value), scale: '' })),
    }]
  }

  return template.sections.map(section => ({
    key: section.key,
    title: section.title,
    ...sectionScore(section.scored, scores.get(section.key)),
    answers: section.questions.map((question) => {
      const value = question.type === 'date' ? showDate(answers[question.key]) : showAnswer(answers[question.key])
      return {
        key: question.key,
        title: question.title,
        value,
        // У пропуска шкалы нет: «— из 10» читалось бы как оценка, которой не ставили.
        scale: question.type === 'scale' && question.scale !== undefined && value !== NO_ANSWER
          ? `из ${question.scale.max}`
          : '',
      }
    }),
  }))
}

/**
 * Балл раздела и подпись к нему — теми же правилами, что в деле ленты сделки.
 *
 * ⚠ Оцениваемый раздел говорит о себе ВСЕГДА: низший балл с подписью «ответ на 0 из N»
 * или, если балла нет вовсе, «без оценки» (`NO_SCORE_NOTE`) — это сигнал, а молчание
 * неотличимо от «раздела не было».
 */
function sectionScore(scoredSection: boolean, score: SectionScoreRow | undefined): { score: string, note: string } {
  if (score !== undefined && score.score !== null) {
    return { score: formatScore(score.score), note: partialScoreNote(score.answered, score.scored) }
  }
  return { score: '', note: scoredSection ? NO_SCORE_NOTE : '' }
}

/** Счётчик вопросов: целое неотрицательное, иначе ноль. */
function count(raw: unknown): number {
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * Значение ответа для показа.
 *
 * ⚠ Ноль — это ответ, а пропуск — нет. `0` показывается нулём, `null` и пустая строка —
 * прочерком. Балльный вопрос не имеет предустановленного значения ровно ради этого различия,
 * и терять его на последнем шаге, в показе, было бы обиднее всего.
 */
export function showAnswer(value: unknown): string {
  if (value === null || value === undefined) return NO_ANSWER
  const text = String(value).trim()
  return text === '' ? NO_ANSWER : text
}

/** Дата ответа по-русски: `2026-09-20` → `20.09.2026`. Всё остальное — как пришло. */
function showDate(value: unknown): string {
  const text = showAnswer(value)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  return match === null ? text : `${match[3]}.${match[2]}.${match[1]}`
}

/**
 * Балл числом.
 *
 * ⚠ `null` и пустая строка разбираются ПЕРВЫМИ, до `Number`: `Number(null) === 0`
 * и `Number('') === 0`, и незаполненный балл показывался бы честным нулём — та самая ловушка,
 * на которой проект уже горел (разбор «балл 0» в `docs/PROCESS.md`).
 */
export function asScore(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    return JSON.parse(raw)
  }
  catch {
    return null
  }
}
