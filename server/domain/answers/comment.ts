import type { AnswerValue } from '../surveys/answer'
import type { SurveyTemplate } from '../surveys/model'
import type { SectionScore, SurveyScore } from '../surveys/scoring'

/**
 * Builds the text a manager reads in the deal's timeline.
 *
 * Это то место, ради которого весь путь и затевался: менеджер открывает сделку и видит,
 * что ответил клиент. Не превью, не «оценка 7», а балл и текст целиком.
 *
 * ⚠ Текст **не обрезается** — это требование `docs/PROCESS.md`, раздел 6, и оно не про
 * аккуратность. Развёрнутый ответ клиента и есть самое ценное, что приносит опрос; обрезав
 * его до превью, мы оставим менеджеру ровно ту бесполезную среднюю цифру, против которой
 * написан весь проект.
 *
 * ⚠ Текст собирается ПЛОСКИМ, без разметки. Таймлайн Битрикс24 понимает и BB, и HTML,
 * и соблазн выделить заголовки жирным велик — но в текст попадает то, что набрал посторонний
 * человек, и строить из этого разметку значит отдать ему управление вёрсткой записи в чужой
 * CRM. Разделители здесь наши и не собираются из ответов.
 *
 * ⚠ Носитель теперь — ДЕЛО, а не комментарий: `crm.timeline.comment.add` не идемпотентен,
 * и повтор доставки добавлял бы второй комментарий. См. `timeline-activity.ts`. Там же
 * выставляется `DESCRIPTION_TYPE = 1` (простой текст) — значение снято с живого портала
 * методом `crm.enum.contenttype`, а не взято из памяти.
 *
 * ⚠ Этого мало, и первая версия на этом и остановилась. Не строить разметку самим — полдела;
 * вторая половина в том, что её может построить ОТВЕТИВШИЙ. Ссылка на анкету открыта
 * постороннему неаутентифицированному человеку, а его текст едет в карточку сделки, которую
 * сотрудники клиента читают с доверием к источнику. `[URL=…]Счёт на оплату[/URL]` выглядел бы
 * там обычной ссылкой, поставленной коллегой. Поэтому в тексте респондента квадратные скобки
 * обезвреживаются — см. `neutralizeMarkup`. Нашла панель ревью PR #22.
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
  score: SectionScore | undefined,
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
    // Формулировка вопроса не обезвреживается: её писал сотрудник портала, у неё тот же
    // уровень доверия, что у самой CRM. Обезвреживается ровно то, что набрал посторонний.
    lines.push(`${question.title}:`, neutralizeMarkup(value))
  }

  return lines
}

/** Балл в русской записи: запятая, а не точка, и без хвостовых нулей. */
function format(score: number): string {
  return String(score).replace('.', ',')
}

/**
 * Обезвредить разметку в тексте, который набрал респондент.
 *
 * ⚠ Скобки ЗАМЕНЯЮТСЯ на полноширинные, а не вырезаются. Текст ответа не обрезается и не
 * теряется — это требование раздела 6, — он остаётся читаемым целиком, просто перестаёт быть
 * разметкой. Из всех способов этот единственный не делает текст хуже: вырезание крадёт символы,
 * невидимый разделитель внутри скобок ломает копирование, а экранирования у BB-кода нет.
 *
 * ⚠ Сегодня это ВТОРАЯ линия, а не единственная: запись едет делом с `DESCRIPTION_TYPE = 1`,
 * и портал не разбирает в ней ни BB, ни HTML. Обезвреживание оставлено намеренно — тип
 * описания проставляется ОТДЕЛЬНЫМ вызовом после создания, и полагаться на то, что чужой
 * метод всегда отработает, значит держать защиту на одном гвозде. Цена — два символа
 * начертания в тексте, который их почти никогда не содержит.
 */
export function neutralizeMarkup(text: string): string {
  return text.replaceAll('[', '［').replaceAll(']', '］')
}
