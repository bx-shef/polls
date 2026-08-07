/**
 * Канал обратной связи «сотрудник»: 👍/👎 с необязательным комментарием из интерфейса → issue в
 * приватном репозитории-приёмнике. Чистый конструктор; сеть и настройки — на серверном слое.
 *
 * **Приватность у нас строже, чем в соседнем проекте, и это осознанно.** Там в отзыв кладут контекст
 * задания (имя файла, номер сделки), потому что смысл продукта — разбор конкретного документа. У нас
 * продукт — АНОНИМНЫЕ опросы: ответы клиентов защищены порогом анонимности, а имена клиентов и
 * ответственных лежат в снимке контекста. Поэтому в отзыв не идёт ничего, что указывает на человека:
 * только ключ опроса, номер версии и экран, с которого нажали. Комментарий пишет сотрудник — он
 * свободный текст и МОЖЕТ содержать что угодно, поэтому репозиторий-приёмник обязан быть **приватным**.
 * ⚠️ Приватность приёмника — требование к владельцу, **технически она не проверяется**: код лишь не даёт
 * репозиторию подставиться по умолчанию (`resolveFeedbackConfig` требует явного значения). Указать
 * публичный репозиторий по-прежнему можно — и тогда текст сотрудника окажется в открытом доступе.
 *
 * Санитизация — не украшение. Отзыв попадает в список issue, который читают люди: недоверенный текст
 * не должен уметь ни подделать разметку, ни спрятать содержимое от читателя (Trojan Source).
 */

// Санитизация недоверенного текста — общая с показом ошибок на странице опроса (`domain/text`):
// правило «символ, который умеет переставить или спрятать текст, до читателя не доходит» одно на оба
// места, а две копии регулярки однажды разъехались бы.
import { stripHostileChars, toSingleLine } from './text'

export { stripHostileChars }

/** Оценка: 👍 или 👎. Слова — для заголовка issue. */
export const FEEDBACK_KINDS = { up: 'положительный 👍', down: 'отрицательный 👎' } as const
export type FeedbackKind = keyof typeof FEEDBACK_KINDS

/** Комментарий длиннее — обрезаем: issue не должен превращаться в дамп. */
export const MAX_COMMENT_LENGTH = 5000
/** Кап одного поля контекста. */
export const MAX_CONTEXT_VALUE = 200

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
  /** Экран, с которого отправлен отзыв. Только из {@link FEEDBACK_SCREENS}. */
  screen?: unknown
  /**
   * Псевдоним портала — солёный хеш, НЕ идентификатор. Ставит сервер из сессии, клиент его не шлёт.
   *
   * Зачем он нужен, хотя мы бережём анонимность: порог анонимности защищает **респондента** — клиента
   * заказчика. Автор отзыва — сотрудник портала, и он у нас не аноним по построению (у него сессия).
   * Без привязки к порталу отзыв «дашборд тормозит» нечинибельный: нельзя ни сопоставить с логами, ни
   * увидеть «три жалобы из одного портала», ни ответить заказчику. Хеш даёт эту связность, но по нему
   * нельзя восстановить ни портал, ни человека.
   */
  portalAlias?: unknown
}

/**
 * Допустимые экраны. Перечень закрытый: значение приходит с клиента, и без него в поле «Экран» можно
 * было бы прислать что угодно, включая персональные данные — то есть ограничение по именам полей
 * ничего бы не стоило.
 */
export const FEEDBACK_SCREENS = ['dashboard', 'admin', 'deal-widget'] as const
export type FeedbackScreen = (typeof FEEDBACK_SCREENS)[number]

/** Экран, если он из списка; иначе `undefined` (строка просто не попадёт в issue). */
export function normalizeScreen(raw: unknown): FeedbackScreen | undefined {
  return (FEEDBACK_SCREENS as readonly string[]).includes(String(raw)) ? (raw as FeedbackScreen) : undefined
}

/** Номер версии, если это разумное целое; иначе `undefined`. */
export function normalizeVersionNo(raw: unknown): number | undefined {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 1e6 ? n : undefined
}

/**
 * Отобрать поля контекста из недоверенного тела: аллоулист имён + нормализация значений в одном месте.
 * Иначе список полей дублировался бы между роутом и конструктором и однажды разошёлся.
 * `portalAlias` СЮДА не входит намеренно — его ставит сервер из сессии, клиент на него не влияет.
 */
export function pickFeedbackContext(raw: unknown): FeedbackContext {
  const c = (raw ?? {}) as Record<string, unknown>
  return {
    surveyKey: c.surveyKey,
    versionNo: normalizeVersionNo(c.versionNo),
    screen: normalizeScreen(c.screen)
  }
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
  const flat = toSingleLine(value).replace(/`/g, '').trim().slice(0, MAX_CONTEXT_VALUE)
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
  const clean = sanitizeComment(comment).trim()
  // Заголовок issue — обычный текст, HTML в нём не рендерится. Берём его из ЧИСТОГО комментария:
  // из экранированного получалось бы «цена &amp;lt; 0», да ещё и обрезка могла разрубить сущность пополам.
  // Режем и по CR: одинокий возврат каретки во многих клиентах — тоже перенос строки, и заголовок
  // issue разъехался бы на две. Обрезаем по КОДОВЫМ ТОЧКАМ: `slice` по UTF-16 разрубил бы эмодзи
  // пополам, а битая суррогатная пара в JSON — повод для GitHub ответить 422.
  const firstLine = [...(clean.split(/[\r\n]/, 1)[0] ?? '')].slice(0, 80).join('').trim()
  const kindWord = FEEDBACK_KINDS[kind]
  const title = firstLine ? `${kindWord} · ${firstLine}` : `Отзыв сотрудника — ${kindWord}`
  // В тело идёт экранированный вариант — там он внутри <pre><code>.
  const safe = escapeHtml(clean) || '(без текста)'
  const contextLines = [
    contextLine('Опрос', context.surveyKey),
    contextLine('Версия опроса', context.versionNo),
    contextLine('Экран', context.screen),
    contextLine('Портал (псевдоним)', context.portalAlias)
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
