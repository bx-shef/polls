import type { AnswerValue } from '../surveys/answer'
import type { SurveyTemplate } from '../surveys/model'
import { NO_SCORE_NOTE, formatScore, partialScoreNote } from '../surveys/result-view'
import type { SurveyScore } from '../surveys/scoring'
import type { PortalCall } from '../portals/smart-processes'
import type { ActivityOwner } from './timeline-activity'

/**
 * Our blocks on the result activity: the total, each section's score and each question's score (#84, п. 6).
 *
 * ⚠ ЗАЧЕМ. Итог опроса был одним куском BB-текста в описании дела: разделы, баллы вопросов,
 * текстовые ответы, итог. Цифры в нём сверяют взглядом, а читать их простынёй тяжело.
 * Блоки дают порталу структуру «подпись — значение», и цифры уходят в таблицу. В описании
 * остаются заголовок и текстовые ответы клиента: их читают текстом (`buildResultDescription`).
 * Образец — сосед `client-bank-alfa-by`, `app/utils/activityBlocks.ts` (его #729).
 *
 * ⚠ БЛОКИ — ОТДЕЛЬНЫЙ ВЫЗОВ, и он может не дойти. Поэтому здесь нет ничего, чего нет больше
 * нигде: итоговый балл стоит в заголовке дела, баллы разделов и вопросов — в карточке
 * «Результата опросов» (поле «Результат опроса»), куда ведёт последний блок.
 *
 * ⚠ ТОЛЬКО В КОНТЕКСТЕ ПРИЛОЖЕНИЯ. Вебхуком `crm.activity.layout.blocks.set` отвечает
 * `ERROR_WRONG_CONTEXT` (документация; замерено 29.09 — и отдаёт это HTTP 400). Доставка ходит
 * токенами приложения и блоки ставит; живая проверка `verify:link` ходит вебхуком и блоков
 * не ставит — там их проверяют глазами.
 *
 * ⚠ СЛОВАРЬ ЗАКРЫТ, И ОН НЕ НАШ. Шесть типов блоков, не больше 20 штук, ключи — латиница,
 * цифры, дефис и подчёркивание (`KEY_CONTAIN_WRONG_SYMBOLS`), в `withTitle` вкладываются
 * только `text`, `link` и `deadline`. Цвета текста — `base_50`…`base_90`, размеры — `xs`/`sm`/`md`.
 *
 * ⚠ В блоках нет ни одного символа, набранного респондентом: баллы — числа, проверенные при
 * приёме, а формулировки писал сотрудник портала. Текст клиента живёт в описании и проходит
 * `neutralizeMarkup`.
 */

/** Метод, которым блоки вешаются на дело. */
export const ACTIVITY_BLOCKS_SET_METHOD = 'crm.activity.layout.blocks.set'

/** Предел портала на число блоков в наборе (`TOO_MANY_ITEMS`). */
export const MAX_LAYOUT_BLOCKS = 20

/** A block as the portal takes it. */
export interface LayoutBlock {
  type: string
  properties: Record<string, unknown>
}

/**
 * The set: block key → block, drawn in the order listed.
 *
 * ⚠ Ключи — не числа, и это важно: у объекта JavaScript числовые ключи встают вперёд по возрастанию,
 * и порядок вставки для них не сохраняется. `total`, `s1`, `s1q2`, `card` идут так, как вставлены.
 */
export type LayoutBlocks = Record<string, LayoutBlock>

/** Where the survey element's card lives: the last block leads there. */
export interface SurveyCardRef {
  entityTypeId: number
  itemId: number
}

/** One row with its key. */
interface Row {
  key: string
  block: LayoutBlock
}

/** A section's rows: its heading, then its questions' scores. */
interface SectionRows {
  header: Row
  questions: Row[]
  /**
   * The heading carries the section's score (or «без оценки») — worth showing on its own.
   * A plain heading over scale answers is not: without its rows it says nothing.
   */
  scored: boolean
}

/**
 * Собрать блоки итога.
 *
 * Порядок — сверху вниз: итоговый балл, затем разделы анкеты в её порядке, у каждого — его балл
 * и баллы вопросов, и последним — ссылка на карточку «Результата опросов».
 *
 * ⚠ НЕ ВЛЕЗАЕТ В 20 — разделы с баллом остаются все, а баллы вопросов добираются раздел за разделом,
 * пока влезают: раздел показывает либо все свои вопросы, либо ни одного. Не влезают и сами
 * разделы — остаются первые. Раздел без балла, чьи вопросы не влезли, не показывается вовсе: голая
 * шапка без строк под ней ничего не говорит. Ссылка внизу говорит, что остальное в карточке.
 * Молча отвергнутый набор оставил бы дело без блоков вовсе, а усечённый хоть что-то показывает.
 * Прежняя редакция при нехватке места снимала баллы ВСЕХ вопросов сразу, хотя большая часть
 * влезала (`/review`, PR #102). Анкета «brand» (3 раздела, 8 балльных вопросов) даёт 13 блоков —
 * её это не касается.
 */
export function buildResultBlocks(
  template: SurveyTemplate,
  answers: Record<string, AnswerValue>,
  score: SurveyScore,
  card: SurveyCardRef,
): LayoutBlocks {
  const head: Row[] = score.overall === null
    ? []
    : [{ key: 'total', block: row('Итоговый балл', formatScore(score.overall), { bold: true, color: 'base_90' }) }]
  const sections = template.sections
    .map((section, index) => sectionRows(section, index + 1, answers, score))
    .filter((rows): rows is SectionRows => rows !== null)

  // Место под строки разделов: предел без итога и без ссылки внизу.
  const budget = MAX_LAYOUT_BLOCKS - head.length - 1
  const everything = sections.flatMap(rows => [rows.header, ...rows.questions])
  if (everything.length <= budget) return assemble([...head, ...everything], cardLink(card, 'Разбор анкеты — в карточке опроса'))

  const headed = sections.filter(rows => rows.scored)
  if (headed.length > budget) {
    return assemble([...head, ...headed.slice(0, budget).map(rows => rows.header)], cardLink(card, 'Остальные разделы и баллы вопросов — в карточке опроса'))
  }

  let left = budget - headed.length
  const picked: Row[] = []
  for (const rows of sections) {
    if (rows.scored) {
      picked.push(rows.header)
      if (rows.questions.length <= left) {
        picked.push(...rows.questions)
        left -= rows.questions.length
      }
    }
    else if (1 + rows.questions.length <= left) {
      picked.push(rows.header, ...rows.questions)
      left -= 1 + rows.questions.length
    }
  }
  return assemble([...head, ...picked], cardLink(card, 'Остальные баллы вопросов — в карточке опроса'))
}

/**
 * Строки одного раздела: его балл, потом баллы вопросов со шкалой.
 *
 * ⚠ Подписи — те же, что были в тексте дела и что у виджета в карточке: `partialScoreNote`
 * и `NO_SCORE_NOTE`. Одно прохождение, три места показа.
 */
function sectionRows(
  section: SurveyTemplate['sections'][number],
  index: number,
  answers: Record<string, AnswerValue>,
  score: SurveyScore,
): SectionRows | null {
  const questions: Row[] = []
  section.questions.forEach((question, position) => {
    const value = answers[question.key]
    // ⚠ Балл КАЖДОГО вопроса, а не только раздела: «Результат: 9» без 10 и 8 за ним владелец
    // уже ловил. Пропуск строки не даёт — о нём говорит подпись раздела «ответ на N из M».
    if (question.type !== 'scale' || typeof value !== 'number') return
    const max = question.scale === undefined ? '' : ` из ${formatScore(question.scale.max)}`
    questions.push({ key: `s${index}q${position + 1}`, block: row(question.title, `${formatScore(value)}${max}`) })
  })

  const own = score.sections.find(item => item.key === section.key)
  const title = section.title === '' ? `Раздел ${index}` : section.title

  if (own !== undefined && own.score !== null) {
    const partial = partialScoreNote(own.answered, own.scored)
    const value = `${formatScore(own.score)}${partial === '' ? '' : ` (${partial})`}`
    return { header: { key: `s${index}`, block: row(title, value, { bold: true }) }, questions, scored: true }
  }
  // Балльный раздел без балла — перенесённая анкета, опубликованная мимо проверки: говорим об этом,
  // а не молчим (та же ветка, что была в тексте дела).
  if (section.scored) return { header: { key: `s${index}`, block: row(title, NO_SCORE_NOTE, { bold: true }) }, questions, scored: true }
  // Раздел без балла, но с ответами по шкале: шапка — просто название, баллы вопросов под ней.
  if (questions.length > 0) return { header: { key: `s${index}`, block: text(title, { bold: true }) }, questions, scored: false }
  return null
}

/**
 * Строка таблицы: подпись слева, значение справа.
 *
 * `inline` — иначе портал переносит значение на следующую строку, и таблица перестаёт читаться
 * колонками (подобрано у соседа на живом портале).
 */
function row(title: string, value: string, props: Record<string, unknown> = {}): LayoutBlock {
  return { type: 'withTitle', properties: { title, inline: true, block: text(value, props) } }
}

function text(value: string, props: Record<string, unknown> = {}): LayoutBlock {
  return { type: 'text', properties: { value, ...props } }
}

/**
 * Ссылка на карточку элемента «Результата опросов».
 *
 * ⚠ Адрес ОТНОСИТЕЛЬНЫЙ, по пути портала: приложение живёт в чужом портале, и абсолютный адрес
 * был бы чужим доменом, зашитым в дело. Форма `/crm/type/<тип>/details/<номер>/` — адрес карточки
 * элемента смарт-процесса.
 */
function cardLink(card: SurveyCardRef, caption: string): LayoutBlock {
  return {
    type: 'link',
    properties: { text: caption, action: { type: 'redirect', uri: `/crm/type/${card.entityTypeId}/details/${card.itemId}/` } },
  }
}

function assemble(rows: Row[], link: LayoutBlock): LayoutBlocks {
  const blocks: LayoutBlocks = {}
  for (const item of rows) blocks[item.key] = item.block
  blocks.card = link
  return blocks
}

/**
 * Параметры `crm.activity.layout.blocks.set`.
 *
 * ⚠ Адресуется парой «сущность + дело»: портал проверяет по ней права и то, что дело к сущности
 * привязано (`OWNER_NOT_FOUND`). Отдаём ту, которую назвал сам портал (`ownerOf`).
 *
 * Повтор безопасен: новый набор приложения целиком заменяет прежний (документация).
 */
export function buildActivityBlocksCall(activityId: string, owner: ActivityOwner, blocks: LayoutBlocks): PortalCall {
  return {
    method: ACTIVITY_BLOCKS_SET_METHOD,
    params: { entityTypeId: owner.entityTypeId, entityId: owner.entityId, activityId: Number(activityId), layout: { blocks } },
  }
}

/** Did the portal take the set: `{result: {success: true}}` (documented answer). */
export function readBlocksApplied(response: unknown): boolean {
  const result = (response as { result?: { success?: unknown } } | null)?.result
  return result?.success === true
}
