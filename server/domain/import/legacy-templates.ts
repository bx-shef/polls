import { htmlToText, looksLikeHtml } from './html-text'
import type { ImportedTemplates, ImportWarning, ImportWarningCode } from './warnings'
import type {
  SurveyBand,
  SurveyQuestion,
  SurveyQuestionType,
  SurveySection,
  SurveyTemplate,
} from '../surveys/model'

/**
 * Turns the legacy module's `b_option` rows into normalized survey templates.
 *
 * Источник — настройки модуля `shef.questionary`: реестр типов `questionary_list` и по одной
 * строке `questionary_group_<код>` на анкету, в каждой JSON с секциями, вопросами, весами
 * и диапазонами интерпретации. Это прямой донор для шаблонов, другого места с формой анкеты
 * в источнике нет.
 *
 * Формулировок вопросов здесь НЕТ: в конфигурации `NAME` пустой у КАЖДОГО поля — проверено
 * на всех 114 полях реконструкции. Настоящий текст лежит подписями полей
 * (`b_user_field_lang`), поэтому подписи передаются отдельным аргументом: без них шаблон
 * переносится с пустыми заголовками, и это видно в отчёте, а не молча.
 *
 * Чистая функция: ни базы, ни сети. Разбор проверяется на реальных структурах из
 * `legacy/questionary-structure.txt`, а не на придуманных.
 */

/** Строка `b_option`, как её отдаёт запрос снимка. */
export interface LegacyOption {
  name: string
  value: string
}

/** Подпись поля из `b_user_field_lang`, привязанная к таблице ответов своей анкеты. */
export interface LegacyFieldLabel {
  /** Код анкеты, добытый из имени таблицы `sh_qest_h_<код>`. */
  template: string
  /** Код поля `UF_*`. */
  field: string
  title: string
}

const OPTION_REGISTRY = 'questionary_list'
const OPTION_GROUP_PREFIX = 'questionary_group_'

/**
 * Ключ секции открытых вопросов.
 *
 * В источнике секция опознаётся по свойству карточки, куда пишется её балл. Пустое значение —
 * секция открытых вопросов: балла у неё нет, поэтому и свойства нет.
 */
const OPEN_SECTION_KEY = 'open'

/**
 * Разобрать настройки модуля в шаблоны.
 *
 * Возвращает и шаблоны, и предупреждения: ни один случай «перенеслось не буквально» не должен
 * теряться — отчёт о переносе часть услуги, и клиент узнаёт об искажениях до записи.
 */
export function readLegacyTemplates(
  options: readonly LegacyOption[],
  labels: readonly LegacyFieldLabel[] = [],
): ImportedTemplates {
  const warnings: ImportWarning[] = []
  const titles = readRegistry(options)
  const titleOf = indexLabels(labels)
  const templates: SurveyTemplate[] = []

  for (const option of options) {
    if (!option.name.startsWith(OPTION_GROUP_PREFIX)) continue
    const code = option.name.slice(OPTION_GROUP_PREFIX.length)
    if (code === '') continue

    const raw = parseJson(option.value)
    if (!Array.isArray(raw)) {
      warnings.push(warn('template-unreadable', code, option.name, 'конфигурация анкеты не разобралась как список секций'))
      continue
    }

    templates.push({
      code,
      title: titles[code] ?? code,
      sections: readSections(code, raw as unknown[], titleOf, warnings),
    })
  }

  templates.sort((a, b) => a.code.localeCompare(b.code))
  return { templates, warnings }
}

/**
 * Реестр типов: код анкеты → её название.
 *
 * Форма реестра в источнике не одна — встречается и объект `{код: название}`, и список.
 * Разбираем обе и не падаем ни на одной: отсутствие названия стоит пустого заголовка,
 * а не потерянного шаблона.
 *
 * Защиты от `__proto__` в ключах здесь нет намеренно, в отличие от `server/b24/event-body.ts`,
 * где она обязательна. Разница в том, ЧТО записывается: там в цепочку кладутся объекты
 * (`node[segment] = {}`), и загрязнение прототипа реально; здесь значение всегда строка,
 * отсеянная `typeof`, а присваивание строки в `__proto__` — пустая операция. Если однажды
 * сюда начнут писать объект, защиту придётся завести.
 */
function readRegistry(options: readonly LegacyOption[]): Record<string, string> {
  const row = options.find(o => o.name === OPTION_REGISTRY)
  if (row === undefined) return {}

  const parsed = parseJson(row.value)
  const titles: Record<string, string> = {}

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const item = entry as { CODE?: unknown, NAME?: unknown }
      if (typeof item?.CODE === 'string' && typeof item.NAME === 'string') {
        titles[item.CODE.toLowerCase()] = item.NAME
      }
    }
    return titles
  }

  if (parsed !== null && typeof parsed === 'object') {
    for (const [code, title] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof title === 'string') titles[code.toLowerCase()] = title
    }
  }
  return titles
}

/**
 * Индекс подписей: пара «анкета + поле» → формулировка.
 *
 * Регистр приводится с обеих сторон намеренно. Подписи приезжают выгрузкой из MySQL, где
 * разнобой регистра обычное дело, а промах по индексу здесь ничего не ломает — он оставляет
 * заголовок пустым. Тихо, без предупреждения, и заметить это можно только на настоящем снимке.
 */
function indexLabels(labels: readonly LegacyFieldLabel[]): (template: string, field: string) => string {
  const index = new Map<string, string>()
  for (const label of labels) {
    // ⚠ Хвостовые пробелы и `\r` обрезаются. В настоящем снимке формулировки приезжают
    // как «качество аналитики\r» — источник лежит в MySQL с виндовыми переводами строк.
    // Невидимый символ уехал бы в анкету, которую читает посторонний человек, и всплыл бы
    // лишним переносом ровно там, где его никто не ждёт.
    index.set(labelKey(label.template, label.field), label.title.trim())
  }
  return (template, field) => index.get(labelKey(template, field)) ?? ''
}

/** Разделитель — символ, который не может встретиться ни в коде анкеты, ни в имени поля. */
function labelKey(template: string, field: string): string {
  return `${template.toLowerCase()}|${field.toUpperCase()}`
}

function readSections(
  template: string,
  rawSections: readonly unknown[],
  titleOf: (template: string, field: string) => string,
  warnings: ImportWarning[],
): SurveySection[] {
  const sections: SurveySection[] = []
  const seenKeys = new Map<string, number>()

  // Первый проход — собрать вопросы; расщепление возможно только когда видны все секции.
  for (const rawSection of rawSections) {
    const source = rawSection as { NAME?: unknown, FIELD?: unknown, FIELDS?: unknown, TERMS?: unknown }
    const key = sectionKey(source.FIELD)
    const questions = readQuestions(template, source.FIELDS, titleOf, warnings)

    for (const question of questions) {
      seenKeys.set(question.sourceKey, (seenKeys.get(question.sourceKey) ?? 0) + 1)
    }

    sections.push({
      key,
      title: typeof source.NAME === 'string' ? source.NAME : '',
      scored: key !== OPEN_SECTION_KEY,
      questions,
      bands: readBands(template, key, source.TERMS, sectionScale(questions), warnings),
    })
  }

  splitDuplicateKeys(template, sections, seenKeys, warnings)
  checkWeights(template, sections, warnings)
  return sections
}

/**
 * Расщепить вопрос, стоящий в нескольких секциях.
 *
 * ⚠ Суффикс получают ВСЕ вхождения, а не только второе. Оставить первому голый код — значит
 * спрятать пару: в списке вопросов он выглядел бы обычным, и связь с близнецом видел бы только
 * тот, кто помнит про этот случай. Обоим при пересчёте отдаётся одно значение (`sourceKey`
 * у них общий) — именно так баллы сходятся с историческими.
 *
 * ⚠ Функция правит `question.key` НА МЕСТЕ. `readonly` в сигнатуре запрещает менять сам массив,
 * но не его элементы, и это здесь не лазейка: объекты только что построены соседней функцией,
 * наружу до `return` не уходят, других ссылок на них нет.
 *
 * Суффикса по секции недостаточно, если один код встретился дважды ВНУТРИ одной секции: тогда
 * оба получили бы одинаковый ключ, и уникальность, ради которой всё затевалось, не наступила бы.
 * В одиннадцати разобранных анкетах такого нет, но `digital` мы не видели — поэтому ключ
 * дополняется порядковым номером, а не проверяется надеждой.
 */
function splitDuplicateKeys(
  template: string,
  sections: readonly SurveySection[],
  seenKeys: ReadonlyMap<string, number>,
  warnings: ImportWarning[],
): void {
  const split = new Set<string>()
  const taken = new Set(sections.flatMap(s => s.questions).map(q => q.key))

  for (const section of sections) {
    for (const question of section.questions) {
      if ((seenKeys.get(question.sourceKey) ?? 0) < 2) continue
      taken.delete(question.key)
      question.key = uniqueKey(`${question.sourceKey}__${section.key}`, taken)
      taken.add(question.key)
      split.add(question.sourceKey)
    }
  }

  for (const sourceKey of split) {
    warnings.push(warn(
      'question-split',
      template,
      sourceKey,
      'вопрос стоял в нескольких секциях с разными весами: ключ расщеплён по секциям, '
      + 'значение ответа при пересчёте отдаётся каждому',
    ))
  }
}

/** Ключ, которого ещё нет. Номер приписывается только при столкновении, а не всем подряд. */
function uniqueKey(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate
  for (let n = 2; ; n++) {
    const next = `${candidate}_${n}`
    if (!taken.has(next)) return next
  }
}

/** Сумма весов в секции. Проверка, а не исправление: подгонять чужие числа мы не вправе. */
function checkWeights(template: string, sections: readonly SurveySection[], warnings: ImportWarning[]): void {
  for (const section of sections) {
    if (!section.scored) continue

    const scored = section.questions.filter(q => q.scored)
    if (scored.length === 0) {
      warnings.push(warn('section-not-scored', template, section.key, 'в секции нет ни одного вопроса, идущего в оценку'))
      continue
    }

    const total = scored.reduce((sum, q) => sum + q.weight, 0)
    if (total !== 100) {
      warnings.push(warn('weights-not-100', template, section.key, `сумма весов ${total}, а не 100`))
    }
  }
}

function readQuestions(
  template: string,
  rawFields: unknown,
  titleOf: (template: string, field: string) => string,
  warnings: ImportWarning[],
): SurveyQuestion[] {
  if (!Array.isArray(rawFields)) return []
  const questions: SurveyQuestion[] = []

  for (const rawField of rawFields) {
    const field = rawField as { CODE?: unknown, TYPE?: unknown, SETTING?: unknown }
    if (typeof field?.CODE !== 'string' || field.CODE === '') continue

    const type = questionType(field.TYPE)
    // ⚠ SETTING приезжает и объектом, и пустым МАССИВОМ: PHP сериализует пустой словарь
    // как `[]`. Обращение к полю массива вернёт undefined, а не упадёт, но читать его
    // как словарь нельзя — отсюда явная проверка.
    const setting = field.SETTING !== null && typeof field.SETTING === 'object' && !Array.isArray(field.SETTING)
      ? field.SETTING as Record<string, unknown>
      : {}

    // ⚠ Числа приезжают то строками, то числами — в одном и том же файле, в соседних анкетах.
    const weight = type === 'scale' ? toNumber(setting.SIZE, 0) : 0
    const scored = type === 'scale' && weight > 0

    if (type === 'scale' && weight === 0) {
      warnings.push(warn(
        'zero-weight',
        template,
        field.CODE,
        'вес 0 в источнике означал «не идёт в оценку»: перенесён явным флагом, балл не меняется',
      ))
    }
    if (type === 'date') {
      warnings.push(warn('date-as-text', template, field.CODE, 'тип «дата» перенесён текстом в ISO-формате'))
    }

    questions.push({
      key: field.CODE,
      sourceKey: field.CODE,
      title: titleOf(template, field.CODE),
      type,
      weight,
      scored,
      ...(type === 'scale'
        ? { scale: { min: toNumber(setting.MIN, 0), max: toNumber(setting.MAX, 10) } }
        : {}),
    })
  }

  return questions
}

/**
 * Диапазоны интерпретации секции.
 *
 * ⚠ КЛЮЧ ТЕКСТА — `VALUE`, и это теперь ПОДТВЕРЖДЕНО настоящим снимком. Прежняя редакция
 * брала `TEXT` или `NAME` и честно писала рядом, что имя ключа не подтверждено, — оно
 * оказалось третьим. Цена догадки была полной и невидимой: у всех шести диапазонов `digital`
 * текст выходил ПУСТОЙ строкой, а предупреждение `html-stripped` не срабатывало, потому что
 * `looksLikeHtml('')` — ложь. То есть «клиент с плохой оценкой не увидит ничего» —
 * инвариант, ради которого диапазоны и переносятся, — нарушался бы молча.
 *
 * Прежние имена оставлены запасными: они ничего не стоят, а снимок у нас пока один.
 *
 * ⚠ `MAX: "0"` в последнем диапазоне — так в источнике БУКВАЛЬНО, у `digital` это
 * `{"MIN":"9.4","MAX":"0"}`. Диапазон «от 9,4 до 0» не совпадёт ни с чем, то есть верхняя
 * оценка осталась бы без текста. Читаем это как «до верха шкалы» — другого осмысленного
 * чтения нет, — но ОБЯЗАТЕЛЬНО говорим об этом в отчёте: догадка о чужих данных не должна
 * проходить молча, даже верная.
 *
 * Дыры в покрытии не заделываются: у `digital` нижняя граница начинается с 4, и клиент
 * с плохой оценкой не видел ничего. Это в отчёт, а не в тихую правку.
 */
function readBands(
  template: string,
  section: string,
  rawTerms: unknown,
  scale: { min: number, max: number } | null,
  warnings: ImportWarning[],
): SurveyBand[] {
  if (!Array.isArray(rawTerms)) return []
  const bands: SurveyBand[] = []

  for (const rawTerm of rawTerms) {
    const term = rawTerm as { MIN?: unknown, MAX?: unknown, VALUE?: unknown, TEXT?: unknown, NAME?: unknown }
    const source = firstString(term?.VALUE, term?.TEXT, term?.NAME)

    if (looksLikeHtml(source)) {
      warnings.push(warn('html-stripped', template, section, 'текст интерпретации хранился готовым HTML — вычищен до текста'))
    }

    const from = toNumber(term?.MIN, 0)
    let to = toNumber(term?.MAX, 0)
    if (to <= from) {
      // ⚠ Верхняя граница не задана или задана нулём. Оставив как есть, мы получили бы
      // диапазон, который не совпадёт ни с одной оценкой, — и верхняя оценка осталась бы
      // без текста. Тянем до верха шкалы и сообщаем.
      to = scale?.max ?? from
      warnings.push(warn(
        'band-open-end',
        template,
        section,
        `верхняя граница диапазона от ${from} в источнике была ${toNumber(term?.MAX, 0)} — прочитана как «до верха шкалы» (${to})`,
      ))
    }
    bands.push({ from, to, text: htmlToText(source) })
  }

  bands.sort((a, b) => a.from - b.from)
  reportGaps(template, section, bands, scale, warnings)
  return bands
}

/**
 * Шкала секции — по её балльным вопросам.
 *
 * Нужна, чтобы было с чем сравнивать края диапазонов интерпретации. Во всём разобранном
 * наборе шкала везде `0…10`, но брать её константой значит поверить в это навсегда.
 * `null` — считать нечем: в секции нет балльных вопросов, и диапазонам там взяться неоткуда.
 */
function sectionScale(questions: readonly SurveyQuestion[]): { min: number, max: number } | null {
  const scales = questions.map(q => q.scale).filter((s): s is { min: number, max: number } => s !== undefined)
  if (scales.length === 0) return null
  return {
    min: Math.min(...scales.map(s => s.min)),
    max: Math.max(...scales.map(s => s.max)),
  }
}

/**
 * Пожаловаться на дыры в покрытии шкалы.
 *
 * Границы диапазонов в источнике смежные (…6–7.5, 7.5–8…), поэтому дырой между диапазонами
 * считается только настоящий разрыв: следующий начинается ВЫШЕ конца предыдущего.
 *
 * ⚠ Края шкалы проверяются отдельно, и это не педантизм. Сначала здесь сравнивались только
 * соседние пары — и та единственная дыра, ради которой вся проверка писалась, не ловилась:
 * у анкеты `digital` диапазоны шли с 4 и между собой стыковались вплотную, а непокрытым
 * оставался отрезок 0–4. Клиент с плохой оценкой не видел никакого текста, а отчёт о переносе
 * сказал бы «дыр нет». Нашла панель ревью PR #14.
 */
function reportGaps(
  template: string,
  section: string,
  bands: readonly SurveyBand[],
  scale: { min: number, max: number } | null,
  warnings: ImportWarning[],
): void {
  if (bands.length === 0) return

  if (scale !== null && bands[0]!.from > scale.min) {
    warnings.push(warn('band-gap', template, section, `шкала не покрыта на отрезке ${scale.min}–${bands[0]!.from}`))
  }

  for (let i = 1; i < bands.length; i++) {
    const previous = bands[i - 1]!
    const current = bands[i]!
    if (current.from > previous.to) {
      warnings.push(warn('band-gap', template, section, `шкала не покрыта на отрезке ${previous.to}–${current.from}`))
    }
  }

  const last = bands[bands.length - 1]!
  if (scale !== null && last.to < scale.max) {
    warnings.push(warn('band-gap', template, section, `шкала не покрыта на отрезке ${last.to}–${scale.max}`))
  }
}

/** `PROPERTY_PRODUCT` → `product`; пустое — секция открытых вопросов. */
function sectionKey(field: unknown): string {
  if (typeof field !== 'string' || field === '') return OPEN_SECTION_KEY
  const key = field.replace(/^PROPERTY_/i, '').toLowerCase()
  return key === '' ? OPEN_SECTION_KEY : key
}

/**
 * Тип вопроса источника → наш.
 *
 * В источнике типов ровно три: `POINT`, `TEXT`, `DATE`. Умолчание `text` выбрано не по
 * алфавиту: неизвестный тип, принятый за балльный, попал бы в оценку и молча сдвинул балл
 * секции, а принятый за текстовый — просто не попадёт никуда.
 */
function questionType(type: unknown): SurveyQuestionType {
  if (type === 'POINT') return 'scale'
  if (type === 'DATE') return 'date'
  return 'text'
}

/** Число из значения, которое в источнике бывает и строкой, и числом, и мусором. */
function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    return null
  }
}

function warn(code: ImportWarningCode, template: string, at: string, detail: string): ImportWarning {
  return { code, template, at, detail }
}

/** Первая строка из перечисленного. Источник хранит одно и то же под разными именами. */
function firstString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}
