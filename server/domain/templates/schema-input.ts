import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { SurveyBand, SurveyQuestion, SurveyQuestionType, SurveySection, SurveyTemplate } from '../surveys/model'

/**
 * Turning what the builder tab sends into a schema we are willing to store.
 *
 * ⚠ ЭТО ГРАНИЦА ДОВЕРИЯ, а не «валидация формы». Схема приезжает из браузера сотрудника,
 * ложится в смарт-процесс клиента и оттуда попадает на ПУБЛИЧНУЮ страницу, которую открывает
 * посторонний человек. Всё, что мы сюда пустим, он увидит. Поэтому объект не «проверяется»,
 * а СОБИРАЕТСЯ ЗАНОВО поле за полем: лишние ключи не отбрасываются по списку, они просто
 * не переносятся. Список запрещённого устаревает, список разрешённого — нет.
 *
 * ⚠ Проверка СМЫСЛА живёт отдельно, в `server/domain/surveys/validate.ts`, и путать их нельзя.
 * Здесь — «это вообще похоже на схему и влезает в наши границы»; там — «эту анкету можно
 * показывать людям». Первое запрещает сохранять, второе запрещает публиковать: черновик
 * с дырой в диапазонах сохранить МОЖНО, иначе его негде будет доделывать.
 */

/** Предел на схему целиком. Поле текстовое, и портал не обязан принимать что угодно. */
export const MAX_SCHEMA_BYTES = 64 * 1024

/**
 * Предел на одну строку.
 *
 * ⚠ В БАЙТАХ, а не в символах — правило проекта: кириллица весит вдвое, и лимит в символах
 * пропустил бы вдвое больше, чем обещает.
 */
export const MAX_STRING_BYTES = 2 * 1024

/** Сколько всего разделов, вопросов и диапазонов мы готовы принять. */
export const MAX_SECTIONS = 30
export const MAX_QUESTIONS = 60
export const MAX_BANDS = 20

const QUESTION_TYPES: readonly SurveyQuestionType[] = ['scale', 'text', 'date']

/**
 * Новый ключ вопроса — СЛУЧАЙНЫЙ, и это следование инварианту, а не лень.
 *
 * Инвариант: «Ключи вопроса и варианта стабильны и не переиспользуются после удаления».
 * Считать ключи по порядку нельзя ровно из-за второй половины: удалив `Q3` и добавив новый,
 * счётчик «максимум плюс один» выдал бы снова `Q3` — и ответы прошлых версий начали бы
 * складываться с новыми. Случайный ключ делает переиспользование невозможным по построению,
 * а не по внимательности того, кто правит код.
 *
 * ⚠ Ключ НЕ показывается человеку и не редактируется им: он видит формулировку. Красивый
 * ключ нужен был бы только нам, а цена красоты здесь — молчаливое смешение ответов.
 */
export function newQuestionKey(): string {
  return `q${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

/** Новый ключ раздела. Та же причина, что у вопроса: по ключу секции живут баллы. */
export function newSectionKey(): string {
  return `s${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

/** Почему схему не приняли. Наружу уходит текстом, поэтому он сразу человеческий. */
export type SchemaRefusal = 'not-object' | 'too-big' | 'too-many'

/** Собрать схему заново из присланного. `null` — это не схема. */
export function readIncomingSchema(raw: unknown): SurveyTemplate | { refusal: SchemaRefusal } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { refusal: 'not-object' }

  // ⚠ Размер меряется ДО разбора: разбирать мегабайт, чтобы потом отказать, — это и есть
  // способ положить обработку у всех порталов сразу. Тот же приём, что у приёмника установки.
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_SCHEMA_BYTES) return { refusal: 'too-big' }

  const bag = raw as Record<string, unknown>
  const sections = Array.isArray(bag.sections) ? bag.sections : []
  if (sections.length > MAX_SECTIONS) return { refusal: 'too-many' }

  const built: SurveySection[] = []
  let questions = 0

  for (const rawSection of sections) {
    const section = readSection(rawSection)
    questions += section.questions.length
    // ⚠ Диапазоны ОТКАЗЫВАЮТ так же, как разделы и вопросы, а не обрезаются молча. Первая
    // редакция брала первые двадцать `slice`-ом: автор нажимал «Сохранено» и обнаруживал
    // пропажу последних диапазонов когда-нибудь потом — а это дыра в покрытии шкалы,
    // то есть клиент без текста по своей оценке. Нашёл `/code-review`.
    if (questions > MAX_QUESTIONS || section.bands.length > MAX_BANDS) return { refusal: 'too-many' }
    built.push(section)
  }

  return {
    code: text(bag.code),
    title: text(bag.title),
    sections: built,
  }
}

function readSection(raw: unknown): SurveySection {
  const bag = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const questions = Array.isArray(bag.questions) ? bag.questions : []
  const bands = Array.isArray(bag.bands) ? bag.bands : []

  return {
    // Пустой ключ не подставляется новым: его видит проверка смысла и скажет о нём человеку.
    // Подставив тихо, мы получили бы раздел, ключ которого меняется сам по себе.
    key: text(bag.key),
    title: text(bag.title),
    scored: bag.scored === true,
    questions: questions.map(readQuestion),
    bands: bands.map(readBand),
  }
}

function readQuestion(raw: unknown): SurveyQuestion {
  const bag = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const type = QUESTION_TYPES.includes(bag.type as SurveyQuestionType) ? bag.type as SurveyQuestionType : 'text'
  const key = text(bag.key)
  const scale = readScale(bag.scale)

  return {
    key,
    // ⚠ `sourceKey` — код поля в СТАРОМ решении, по нему адаптер импорта брал значение ответа.
    // У вопроса, собранного в конструкторе, источника нет, и выдумывать его нельзя: пусть
    // совпадает с ключом. Обратное — расщепление одного исходного поля на два вопроса —
    // бывает только при переносе, и конструктор такого не делает.
    sourceKey: text(bag.sourceKey) || key,
    title: text(bag.title),
    type,
    weight: finite(bag.weight, 1),
    scored: bag.scored === true,
    // Шкала переносится ТОЛЬКО у балльного вопроса: у остальных она ничего не значит,
    // а в схеме выглядела бы как настройка, которая почему-то не работает.
    ...(type === 'scale' && scale !== null ? { scale } : {}),
  }
}

/**
 * Границы диапазона.
 *
 * ⚠ Пустое поле даёт `NaN`, а НЕ ноль, и это то же правило, что у шкалы. Ноль — законная
 * граница («от 0 до 6»), и подставив его за автора, мы получили бы диапазон, который он
 * не задавал, зато выглядящий заданным. `NaN` же увидит проверка смысла и скажет о нём
 * словами. Нашёл `/code-review`: здесь стоял ноль вопреки правилу самого этого файла.
 */
function readBand(raw: unknown): SurveyBand {
  const bag = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    from: numberOrNull(bag.from) ?? Number.NaN,
    to: numberOrNull(bag.to) ?? Number.NaN,
    text: text(bag.text),
  }
}

function readScale(raw: unknown): { min: number, max: number } | null {
  if (raw === null || typeof raw !== 'object') return null
  const bag = raw as Record<string, unknown>
  const min = numberOrNull(bag.min)
  const max = numberOrNull(bag.max)
  // Нечисловая шкала не подставляется умолчанием: «шкалы нет» — законное состояние
  // недособранного черновика, а `0–10`, подставленные молча, автор принял бы за свои.
  return min !== null && max !== null ? { min, max } : null
}

/**
 * Число или `null`.
 *
 * ⚠ ПУСТАЯ СТРОКА — ЭТО НЕ НОЛЬ, и различать их здесь обязательно. `Number('')` даёт `0`,
 * ровно как `Number(null)`, — и проект на этом уже горел: незаполненное число из портала
 * превращалось в честный «балл 0» у анкеты, которую никто не проходил. Здесь источник тот же
 * по природе: пустое поле формы приезжает пустой строкой, и `0–0` вместо «шкала не задана»
 * автор принял бы за свою шкалу.
 *
 * Поймал собственный тест этой границы — первая редакция сравнивала `Number.isFinite`
 * и пропускала пустую строку.
 */
function numberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** Строка, обрезанная по байтам и очищенная от управляющих символов. */
function text(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // ⚠ Управляющие символы выбрасываются, а не экранируются: в формулировке вопроса им взяться
  // неоткуда, а вот сломать они могут и JSON в поле портала, и показ на публичной странице.
  // Перевод строки оставлен — в тексте диапазона он осмыслен.
  // eslint-disable-next-line no-control-regex
  const clean = raw.replaceAll(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim()
  if (Buffer.byteLength(clean, 'utf8') <= MAX_STRING_BYTES) return clean

  // Режем по кодовым точкам, а не по байтам: срез посреди символа даёт «оборванную» строку,
  // которую портал может не принять вовсе.
  let out = ''
  for (const point of clean) {
    if (Buffer.byteLength(out + point, 'utf8') > MAX_STRING_BYTES) break
    out += point
  }
  return out
}

/** Число с запасным значением. Пустое поле формы — это «не задано», а не ноль. */
function finite(raw: unknown, fallback: number): number {
  return numberOrNull(raw) ?? fallback
}

/**
 * Раздать ключи тем, у кого их нет.
 *
 * ⚠ ОТДЕЛЬНЫМ ШАГОМ, а не внутри разбора, и это разделение несущее. Разбор — граница доверия:
 * он только очищает присланное и ничего не выдумывает, поэтому пустой ключ существующего
 * раздела он оставляет пустым, чтобы о нём сказала проверка смысла. А вот у вопроса, который
 * человек только что добавил во вкладке, ключа нет и взяться ему неоткуда: браузер его выдать
 * не может — генератор живёт в домене, а `app/` в серверные модули не ходит по правилу проекта.
 *
 * ⚠ Существующие ключи НЕ ПЕРЕПИСЫВАЮТСЯ. Инвариант: ключи стабильны. Переписав их при
 * сохранении, мы оторвали бы уже собранные ответы от их вопросов — молча и необратимо.
 */
export function assignMissingKeys(schema: SurveyTemplate): SurveyTemplate {
  return {
    ...schema,
    sections: schema.sections.map(section => ({
      ...section,
      key: section.key === '' ? newSectionKey() : section.key,
      questions: section.questions.map((question) => {
        if (question.key !== '') return question
        const key = newQuestionKey()
        // `sourceKey` идёт следом: у собранного в конструкторе вопроса источника нет,
        // и он совпадает с ключом — см. разбор в `readQuestion`.
        return { ...question, key, sourceKey: question.sourceKey === '' ? key : question.sourceKey }
      }),
    })),
  }
}
