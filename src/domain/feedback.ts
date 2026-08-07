/**
 * Канал обратной связи «сотрудник»: 👍/👎 с необязательным комментарием из интерфейса → issue в
 * приватном репозитории-приёмнике. Чистый конструктор; сеть и настройки — на серверном слое.
 *
 * **Приватность у нас строже, чем в соседнем проекте, и это осознанно.** Там в отзыв кладут контекст
 * задания (имя файла, номер сделки), потому что смысл продукта — разбор конкретного документа. У нас
 * продукт — АНОНИМНЫЕ опросы: ответы клиентов защищены порогом анонимности, а имена клиентов и
 * ответственных лежат в снимке контекста. Поэтому в отзыв не идёт ничего, что указывает на человека:
 * только ключ опроса, номер версии и экран, с которого нажали. Комментарий пишет сотрудник — он
 * свободный текст и МОЖЕТ содержать что угодно, поэтому репозиторий-приёмник обязан быть **приватным**
 * (это гарантирует `resolveFeedbackConfig`, fail-closed).
 *
 * Санитизация — не украшение. Отзыв попадает в список issue, который читают люди: недоверенный текст
 * не должен уметь ни подделать разметку, ни спрятать содержимое от читателя (Trojan Source).
 */

/** Оценка: 👍 или 👎. Слова — для заголовка issue. */
export const FEEDBACK_KINDS = { up: 'положительный 👍', down: 'отрицательный 👎' } as const
export type FeedbackKind = keyof typeof FEEDBACK_KINDS

/** Комментарий длиннее — обрезаем: issue не должен превращаться в дамп. */
export const MAX_COMMENT_LENGTH = 5000
/** Кап одного поля контекста. */
export const MAX_CONTEXT_VALUE = 200

/**
 * Враждебные и невидимые символы. Записаны escape-последовательностями НАМЕРЕННО: литералы здесь сами
 * были бы Trojan-Source-атакой на того, кто читает этот файл. Убираем: управляющие C0 (кроме таба и
 * переводов строк), переопределения направления текста (U+202A–U+202E, U+2066–U+2069, U+061C),
 * нулевой ширины и BOM (U+200B–U+200D, U+FEFF), невидимые операторы (U+2060–U+2064), разделители
 * строк и абзацев (U+2028/U+2029).
 */
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\u061c\u200b-\u200d\u2028-\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Убрать управляющие, направляющие и невидимые символы из произвольного текста. */
export function stripHostileChars(input: unknown): string {
  return String(input ?? '').replace(HOSTILE_CHARS, '')
}

/** Очистить комментарий и обрезать до разумного предела. */
export function sanitizeComment(input: unknown): string {
  const stripped = stripHostileChars(input)
  if (stripped.length <= MAX_COMMENT_LENGTH) return stripped
  return `${stripped.slice(0, MAX_COMMENT_LENGTH)}…\n\n[обрезано до ${MAX_COMMENT_LENGTH} символов]`
}

/** Сделать текст инертным в теле issue: `&`, `<`, `>` — сущностями (защита в глубину внутри блока кода). */
export function escapeHtml(input: unknown): string {
  return String(input ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Каноническая оценка либо `null` (роут отвечает 400). */
export function normalizeKind(kind: unknown): FeedbackKind | null {
  return kind === 'up' || kind === 'down' ? kind : null
}

export interface IssuePayload {
  title: string
  body: string
  labels: string[]
}

/**
 * Контекст отзыва. **Только обезличенное** — ничего, по чему можно узнать клиента или сотрудника.
 * Сознательно НЕ принимаем: идентификаторы ответа, сделки, компании, контакта, ответственного,
 * а также любые имена. Если такое поле однажды понадобится — сначала решается вопрос анонимности,
 * а не расширяется этот тип.
 */
export interface FeedbackContext {
  /** Ключ опроса (внутренний идентификатор конфигурации, не персональные данные). */
  surveyKey?: unknown
  /** Номер версии опроса. */
  versionNo?: unknown
  /** Экран, с которого отправлен отзыв: `dashboard` / `admin` / `deal-widget`. */
  screen?: unknown
  /** Версия приложения — чтобы понимать, о каком выпуске речь. */
  appVersion?: unknown
}

/**
 * Строка контекста, отрендеренная полностью ИНЕРТНОЙ.
 *
 * Значения приходят с клиента, поэтому не должны уметь подделать разметку в теле issue:
 *  - внутренние переводы строк и табы (их `stripHostileChars` намеренно оставляет) схлопываем в
 *    пробел — иначе значение вырвется из своей строки и допишет в тело лишний раздел;
 *  - убираем обратные кавычки и заворачиваем в код-спан: внутри него `[](), *, _, |, #` выводятся
 *    буквально, то есть ни ссылок, ни картинок, ни форматирования не получится.
 * Пустое значение → строка опускается целиком.
 */
function contextLine(label: string, value: unknown): string | null {
  const flat = stripHostileChars(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/`/g, '')
    .trim()
    .slice(0, MAX_CONTEXT_VALUE)
  return flat ? `- **${label}:** \`${flat}\`` : null
}

/**
 * Собрать `{ title, body, labels }` для issue из оценки, сырого комментария и обезличенного контекста.
 * Комментарий санируется здесь (функция экспортируемая — не полагаемся на то, что её вызвали с уже
 * очищенным значением) и заворачивается в `<pre><code>`, поэтому обратные кавычки, звёздочки и HTML
 * внутри него инертны.
 */
export function buildFeedbackIssue(
  kind: FeedbackKind,
  comment: unknown,
  context: FeedbackContext = {}
): IssuePayload {
  const safe = escapeHtml(sanitizeComment(comment)).trim() || '(без текста)'
  const firstLine = safe.split('\n', 1)[0]!.slice(0, 80).trim()
  const kindWord = FEEDBACK_KINDS[kind]
  const title = (
    firstLine && firstLine !== '(без текста)' ? `${kindWord} · ${firstLine}` : `Отзыв сотрудника — ${kindWord}`
  ).slice(0, 120)
  const contextLines = [
    contextLine('Опрос', context.surveyKey),
    contextLine('Версия опроса', context.versionNo),
    contextLine('Экран', context.screen),
    contextLine('Версия приложения', context.appVersion)
  ].filter((l): l is string => l !== null)
  const body = [
    `- **Оценка:** ${kindWord}`,
    '',
    '**Комментарий:**',
    '<pre><code>',
    safe,
    '</code></pre>',
    ...(contextLines.length ? ['', '**Контекст:**', ...contextLines] : [])
  ].join('\n')
  return { title, body, labels: ['user-feedback', `feedback:${kind}`] }
}
