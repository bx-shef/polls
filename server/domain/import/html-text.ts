/**
 * Turns the source's ready-made HTML into plain text.
 *
 * Тексты интерпретации в старом решении лежали готовой вёрсткой с классами `landing24`:
 * чужой дизайн, вмороженный в данные, — его оттуда уже не вынуть без разбора разметки.
 * Мы храним текст, а не разметку (`docs/PROCESS.md`, раздел 7), поэтому при импорте
 * вычищаем до текста: смысл сохраняется, вид меняется.
 *
 * ⚠ Это НЕ санитайзер и не защита от XSS. Функция готовит данные к сохранению, а не к показу.
 * На публичной странице текст рендерится своим экранирующим парсером — инвариант проекта,
 * и он не отменяется тем, что здесь что-то уже вычищено.
 */

/** Блочные теги, после которых нужен разрыв строки, иначе абзацы слипнутся в одну строку. */
const BLOCK_TAGS = /<\/?(?:p|div|br|li|tr|h[1-6]|blockquote|section|article)\b[^>]*>/gi

/** Сущности, которые реально встречаются в текстах источника. Полная таблица здесь не нужна. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
}

/**
 * Вычистить HTML до текста, сохранив границы абзацев.
 *
 * Порядок важен: сначала блочные теги превращаются в перевод строки, и только потом
 * вырезаются остальные. Наоборот — и три абзаца станут одной строкой без пробелов
 * на стыках, то есть текст склеится словами.
 */
export function htmlToText(html: string): string {
  const withBreaks = html.replace(BLOCK_TAGS, '\n')
  const withoutTags = withBreaks.replace(/<[^>]*>/g, '')
  return collapse(decodeEntities(withoutTags))
}

/** Был ли во входе HTML. По этому признаку в отчёт о переносе попадает предупреждение. */
export function looksLikeHtml(value: string): boolean {
  return /<[a-z/!][^>]*>/i.test(value)
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      // Суррогатные половинки и вышедшее за диапазон оставляем как есть: подставить
      // «замещающий символ» значит тихо испортить текст, который потом читает человек.
      return Number.isInteger(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Свести пробелы: внутри строки — в один, пустые строки — не больше одной подряд.
 *
 * Неразрывный пробел сводится вместе с обычными намеренно: в вёрстке источника он стоял
 * вместо отступа, а не как значащий символ, и сохранять его значит тащить чужую типографику.
 */
function collapse(value: string): string {
  return value
    .split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
