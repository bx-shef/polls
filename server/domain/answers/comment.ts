import type { AnswerValue } from '../surveys/answer'
import type { SurveyTemplate } from '../surveys/model'
import type { SurveyScore } from '../surveys/scoring'

/**
 * Builds the timeline comment a manager reads in the deal.
 *
 * Это то место, ради которого весь путь и затевался: менеджер открывает сделку и видит,
 * что ответил клиент. Не превью, не «оценка 7», а балл и текст целиком.
 *
 * ⚠ Текст **не обрезается** — это требование `docs/PROCESS.md`, раздел 6, и оно не про
 * аккуратность. Развёрнутый ответ клиента и есть самое ценное, что приносит опрос; обрезав
 * его до превью, мы оставим менеджеру ровно ту бесполезную среднюю цифру, против которой
 * написан весь проект.
 *
 * ⚠ Комментарий собирается ПЛОСКИМ ТЕКСТОМ, без BB-кода. Таймлайн Битрикс24 BB-код понимает,
 * и соблазн выделить заголовки жирным велик — но в текст попадает то, что набрал посторонний
 * человек, и строить из этого разметку значит отдать ему управление вёрсткой комментария.
 * Разделители здесь наши и не собираются из ответов.
 */

/** Разделитель секций: наш, из ответа клиента не собирается. */
const RULE = '———'

/**
 * Собрать комментарий.
 *
 * Возвращает пустую строку, если писать нечего вовсе: портал отвергает пустой комментарий
 * (`INVALID_ARG_VALUE`), и вызывающий обязан это проверить, а не отправлять вслепую.
 */
export function buildAnswerComment(
  template: SurveyTemplate,
  answers: Record<string, AnswerValue>,
  score: SurveyScore,
): string {
  const lines: string[] = [`Опрос пройден: ${template.title}`]

  const scores = new Map(score.sections.map(s => [s.key, s]))

  for (const section of template.sections) {
    const parts = sectionLines(section, answers, scores.get(section.key))
    if (parts.length === 0) continue
    lines.push('', RULE, ...parts)
  }

  if (score.overall !== null) {
    lines.push('', RULE, `Итоговый балл: ${format(score.overall)}`)
  }

  // Заголовок один, без единой секции с содержимым, — это не комментарий, а шум.
  return lines.length > 1 ? lines.join('\n') : ''
}

function sectionLines(
  section: SurveyTemplate['sections'][number],
  answers: Record<string, AnswerValue>,
  score: { score: number | null, answered: number, scored: number, band: { text: string } | null } | undefined,
): string[] {
  const lines: string[] = []

  if (score !== undefined && score.score !== null) {
    const partial = score.answered < score.scored
      // ⚠ Неполноту показываем словами. Балл, посчитанный по двум вопросам из пяти, выглядит
      // точно так же, как посчитанный по пяти, — и менеджер сравнил бы несравнимое.
      ? ` (по ${score.answered} из ${score.scored} вопросов)`
      : ''
    lines.push(`${section.title}: ${format(score.score)}${partial}`)
    if (score.band !== null) lines.push(score.band.text)
  }
  else if (section.scored) {
    lines.push(`${section.title}: без оценки — ни один вопрос не заполнен`)
  }

  for (const question of section.questions) {
    if (question.type === 'scale') continue
    const value = answers[question.key]
    // Незаполненный текстовый вопрос не показываем: строка «— не ответил» на каждый
    // пропущенный вопрос превращает комментарий в перечень пустоты.
    if (typeof value !== 'string' || value.trim() === '') continue

    if (lines.length > 0) lines.push('')
    lines.push(`${question.title}:`, value)
  }

  return lines
}

/** Балл в русской записи: запятая, а не точка, и без хвостовых нулей. */
function format(score: number): string {
  return String(score).replace('.', ',')
}
