import { htmlToText, looksLikeHtml } from './html-text'
import type {
  ImportedBand,
  ImportedQuestion,
  ImportedQuestionType,
  ImportedSection,
  ImportedTemplate,
  ImportedTemplates,
  ImportWarning,
  ImportWarningCode,
} from './normalized'

/**
 * Turns the legacy module's `b_option` rows into normalized survey templates.
 *
 * Источник — настройки модуля `shef.questionary`: реестр типов `questionary_list` и по одной
 * строке `questionary_group_<код>` на анкету, в каждой JSON с секциями, вопросами, весами
 * и диапазонами интерпретации. Это прямой донор для шаблонов, другого места с формой анкеты
 * в источнике нет.
 *
 * Формулировок вопросов здесь НЕТ: в конфигурации `NAME` пустой у всех 119 полей, а настоящий
 * текст лежит подписями полей (`b_user_field_lang`). Поэтому подписи передаются отдельно —
 * без них шаблон переносится с пустыми заголовками, и это видно в отчёте, а не молча.
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
  const templates: ImportedTemplate[] = []

  for (const option of options) {
    if (!option.name.startsWith(OPTION_GROUP_PREFIX)) continue
    const code = option.name.slice(OPTION_GROUP_PREFIX.length)
    if (code === '') continue

    const raw = parseJson(option.value)
    if (!Array.isArray(raw)) {
      warnings.push(warn('field-mismatch', code, option.name, 'конфигурация анкеты не разобралась как список секций'))
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

function indexLabels(labels: readonly LegacyFieldLabel[]): (template: string, field: string) => string {
  const index = new Map<string, string>()
  for (const label of labels) {
    index.set(labelKey(label.template, label.field), label.title)
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
): ImportedSection[] {
  const sections: ImportedSection[] = []
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
      bands: readBands(template, key, source.TERMS, warnings),
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
 */
function splitDuplicateKeys(
  template: string,
  sections: readonly ImportedSection[],
  seenKeys: ReadonlyMap<string, number>,
  warnings: ImportWarning[],
): void {
  const split = new Set<string>()

  for (const section of sections) {
    for (const question of section.questions) {
      if ((seenKeys.get(question.sourceKey) ?? 0) < 2) continue
      question.key = `${question.sourceKey}__${section.key}`
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

/** Сумма весов в секции. Проверка, а не исправление: подгонять чужие числа мы не вправе. */
function checkWeights(template: string, sections: readonly ImportedSection[], warnings: ImportWarning[]): void {
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
): ImportedQuestion[] {
  if (!Array.isArray(rawFields)) return []
  const questions: ImportedQuestion[] = []

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
 * ⚠ Имя ключа с текстом НЕ подтверждено: `TERMS` заполнены только у анкеты `digital`, а её
 * конфигурация в реконструкцию `legacy/questionary-structure.txt` не попала. Поэтому текст
 * берётся из `TEXT` или `NAME` — что окажется строкой. Подтвердит настоящий снимок; если ключ
 * окажется третьим, разойдётся только этот разбор, а не весь импорт.
 *
 * Дыры в покрытии не заделываются: у `digital` нижняя граница начиналась с 4, и клиент
 * с плохой оценкой не видел ничего. Чинить чужие данные догадкой нельзя — это в отчёт.
 */
function readBands(template: string, section: string, rawTerms: unknown, warnings: ImportWarning[]): ImportedBand[] {
  if (!Array.isArray(rawTerms)) return []
  const bands: ImportedBand[] = []

  for (const rawTerm of rawTerms) {
    const term = rawTerm as { MIN?: unknown, MAX?: unknown, TEXT?: unknown, NAME?: unknown }
    const source = typeof term?.TEXT === 'string'
      ? term.TEXT
      : typeof term?.NAME === 'string' ? term.NAME : ''

    if (looksLikeHtml(source)) {
      warnings.push(warn('html-stripped', template, section, 'текст интерпретации хранился готовым HTML — вычищен до текста'))
    }
    bands.push({ from: toNumber(term?.MIN, 0), to: toNumber(term?.MAX, 0), text: htmlToText(source) })
  }

  bands.sort((a, b) => a.from - b.from)
  reportGaps(template, section, bands, warnings)
  return bands
}

/**
 * Пожаловаться на дыры в покрытии шкалы.
 *
 * Границы диапазонов в источнике смежные (…6–7.5, 7.5–8…), поэтому дырой считается только
 * настоящий разрыв: следующий диапазон начинается ВЫШЕ конца предыдущего.
 */
function reportGaps(template: string, section: string, bands: readonly ImportedBand[], warnings: ImportWarning[]): void {
  for (let i = 1; i < bands.length; i++) {
    const previous = bands[i - 1]!
    const current = bands[i]!
    if (current.from > previous.to) {
      warnings.push(warn('band-gap', template, section, `шкала не покрыта на отрезке ${previous.to}–${current.from}`))
    }
  }
}

/** `PROPERTY_PRODUCT` → `product`; пустое — секция открытых вопросов. */
function sectionKey(field: unknown): string {
  if (typeof field !== 'string' || field === '') return OPEN_SECTION_KEY
  const key = field.replace(/^PROPERTY_/i, '').toLowerCase()
  return key === '' ? OPEN_SECTION_KEY : key
}

function questionType(type: unknown): ImportedQuestionType {
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
