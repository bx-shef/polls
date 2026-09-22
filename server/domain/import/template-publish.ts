import { buildFieldName } from '../portals/smart-processes'
import type { PortalCall, SmartProcessRef } from '../portals/smart-processes'
import type { SurveyTemplate } from '../surveys/model'

/**
 * Publishing imported drafts: the name the employee typed on the portal goes INTO the schema,
 * and only then does the version become published.
 *
 * ⚠ ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО. Перенос (`template-write.ts`) кладёт анкеты черновиками, потому что
 * человеческих названий в источнике нет вовсе — все двенадцать называются своими кодами.
 * Сотрудник идёт на портал и переименовывает элементы, как подсказывает интерфейс. И вот тут
 * ловушка: РЕСПОНДЕНТ ВИДИТ НЕ ИМЯ ЭЛЕМЕНТА, А `schema.title` — так устроен
 * `readPublishedTemplates`, и устроен намеренно (см. ниже). То есть переименование на портале
 * само по себе не доезжает никуда, и опубликованная анкета навсегда осталась бы «brand».
 *
 * ⚠ ПОЧЕМУ НЕ СДЕЛАТЬ ИМЯ ЭЛЕМЕНТА ГЛАВНЫМ — соблазн очевидный и на один порядок меньше кода.
 * Потому что инвариант проекта: «опубликованная версия неизменяема; правка порождает новую».
 * Имя элемента правится на портале в любой момент и кем угодно. Читая название оттуда, мы бы
 * позволили задним числом переименовать версию, по которой уже собрана статистика, — ровно то,
 * что инвариант запрещает. В схеме название заморожено вместе с версией.
 *
 * Отсюда порядок: назвать, пока черновик, — и публиковать уже названным. Здесь только чистые
 * функции: что публиковать, что нет и как выглядит вызов. Отправляет их интеграция.
 */

/** Элемент «Шаблона опроса», каким его отдал портал. */
export interface PortalTemplateItem {
  id: number
  /** Имя элемента на портале — то, что сотрудник вписал руками. */
  name: string
  code: string
  version: number
  state: string
  /** Разобранная схема или `null`, если JSON не читается. */
  schema: SurveyTemplate | null
}

/**
 * Что делаем с версией.
 *
 * `publish` — черновик становится опубликованным. `rename` — опубликованная версия получает
 * название, которого ей не досталось при переносе; дату публикации при этом не трогаем,
 * потому что публиковали её не сейчас.
 */
export type PublishAction = 'publish' | 'rename'

/** Одна версия, которую публикуем, и имя, которое уедет в схему. */
export interface PlannedPublish {
  id: number
  code: string
  version: number
  /** Название из имени элемента. Оно же станет `schema.title`. */
  name: string
  schema: SurveyTemplate
  action: PublishAction
  /** Сколько приглашений уже выпущено по этой версии. Ноль — переименование никого не застанет. */
  issued: number
}

/** Версия, которую не публикуем, и почему — человеку, а не в журнал. */
export interface SkippedPublish {
  code: string
  version: number
  reason: string
}

/** План публикации: что публикуем и что придётся сначала починить руками. */
export interface TemplatePublishPlan {
  publish: PlannedPublish[]
  skip: SkippedPublish[]
}

/**
 * Прочитать элементы «Шаблона опроса» из ответа портала.
 *
 * ⚠ `select: ['*']`, и это не лень. С `useOriginalUfNames: 'Y'` портал honours в `select`
 * ТОЛЬКО оригинальные имена пользовательских полей, а системные — `id`, `title` — молча
 * выбрасывает, в любом написании. Проверено на живом портале; разбор в `docs/PROCESS.md`.
 * Без `id` публиковать нечего (`crm.item.update` адресуется им), без `title` не узнать
 * название, ради которого всё и затевалось.
 */
export function buildListAllTemplatesCall(template: SmartProcessRef, start = 0): PortalCall {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: template.entityTypeId,
      useOriginalUfNames: 'Y',
      select: ['*'],
      ...(start === 0 ? {} : { start }),
    },
  }
}

/** Разобрать элементы. Нечитаемые не выбрасываются: о них обязан узнать оператор. */
export function readTemplateItems(response: unknown, template: SmartProcessRef): PortalTemplateItem[] {
  const items = (response as { result?: { items?: unknown } } | null)?.result?.items
  if (!Array.isArray(items)) return []

  const field = (postfix: string) => buildFieldName(template.id, postfix)
  const read: PortalTemplateItem[] = []

  for (const raw of items) {
    const item = raw as Record<string, unknown>
    const id = Number(item.id)
    if (!Number.isInteger(id) || id <= 0) continue

    read.push({
      id,
      name: text(item.title).trim(),
      code: text(item[field('CODE')]),
      version: Number(item[field('VERSION')]),
      state: text(item[field('STATE')]),
      schema: parseSchema(item[field('SCHEMA')]),
    })
  }

  return read
}

/** Строка или пусто. Портал отдаёт незаполненное поле то пустой строкой, то `null`. */
function text(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

function parseSchema(raw: unknown): SurveyTemplate | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as SurveyTemplate).sections)) return null
    return parsed as SurveyTemplate
  }
  catch {
    return null
  }
}

/** Сколько приглашений выпущено по версии и сколько из них пройдено. */
export interface VersionUsage {
  issued: number
  completed: number
}

/** Ключ версии в сводке использования. */
export function usageKey(code: string, version: number): string {
  return `${code}@${version}`
}

/**
 * Что можно опубликовать, а что нет.
 *
 * ⚠ НЕНАЗВАННУЮ АНКЕТУ НЕ ПУБЛИКУЕМ, и это главное здесь. Имя, совпадающее с кодом, — это
 * не название, а то, чем её назвал перенос за неимением лучшего. Опубликовав такую, мы
 * заморозили бы «brand» навсегда.
 *
 * ⚠ ОПУБЛИКОВАННУЮ ВЕРСИЮ ПЕРЕИМЕНОВЫВАЕМ — ТОЛЬКО ПОКА ЕЁ НИКТО НЕ ПРОШЁЛ. Это не послабление
 * инварианта, а то, что инвариант и защищает: «правка формулировки задним числом рвёт всю
 * накопленную статистику». Пока статистики нет, рвать нечего. Как только появился первый
 * пройденный опрос — отказ, и единственный правильный путь это новая версия.
 *
 * Случай не выдуманный и не редкий: перенос кладёт анкеты черновиками с машинными именами,
 * а поле «Состояние» на портале — обычная строка, и владелец может опубликовать их руками
 * раньше, чем назовёт. Без этой ветки двенадцать анкет навсегда остались бы «brand»
 * и «concept», а чинилось бы это двенадцатью новыми версиями ради одной строки текста.
 *
 * ⚠ Выпущенные, но не пройденные приглашения переименованию не мешают, и всё же считаются:
 * их ссылки показывают человеку схему на момент выпуска, то есть старое название. Оператор
 * обязан узнать об этом числом, а не догадаться.
 *
 * ⚠ Схему, не разобравшуюся как JSON, не публикуем: выпустить по ней ссылку значит выдать
 * человеку страницу, которая не откроется. Та же логика, что в `readPublishedTemplates`,
 * но здесь отказ ГРОМКИЙ — там фильтр выбора, здесь необратимое действие.
 */
export function planTemplatePublish(
  items: readonly PortalTemplateItem[],
  usage: ReadonlyMap<string, VersionUsage> = new Map(),
): TemplatePublishPlan {
  const plan: TemplatePublishPlan = { publish: [], skip: [] }

  for (const item of items) {
    const at = { code: item.code === '' ? `элемент ${item.id}` : item.code, version: item.version }
    const published = item.state === 'published'

    if (item.code === '' || !Number.isInteger(item.version) || item.version <= 0) {
      plan.skip.push({ ...at, reason: 'нет кода или номера версии' })
      continue
    }
    if (item.schema === null) {
      plan.skip.push({ ...at, reason: 'схема не разобралась как JSON' })
      continue
    }
    if (item.name === '') {
      plan.skip.push({ ...at, reason: 'НЕ НАЗВАНА: имя элемента пустое' })
      continue
    }
    if (item.name === item.code) {
      plan.skip.push({ ...at, reason: `НЕ НАЗВАНА: элемент всё ещё называется кодом «${item.code}»` })
      continue
    }

    const seen = usage.get(usageKey(item.code, item.version)) ?? { issued: 0, completed: 0 }

    if (published && item.schema.title === item.name) {
      plan.skip.push({ ...at, reason: 'уже опубликована, название на месте' })
      continue
    }
    if (published && seen.completed > 0) {
      plan.skip.push({
        ...at,
        reason: `опубликована и уже пройдена (${seen.completed}) — переименование порвало бы статистику, нужна новая версия`,
      })
      continue
    }

    plan.publish.push({
      id: item.id,
      code: item.code,
      version: item.version,
      name: item.name,
      schema: item.schema,
      action: published ? 'rename' : 'publish',
      issued: seen.issued,
    })
  }

  return plan
}

/**
 * Опубликовать версию: название уезжает в схему, состояние становится `published`.
 *
 * ⚠ Пишем и `title` элемента, и `schema.title` ОДНИМ вызовом. Имя элемента сотрудник уже
 * вписал сам, и переписывать его тем же значением кажется лишним — но именно это делает
 * их заведомо одинаковыми в момент публикации. Разъехавшись, они дали бы карточку, которая
 * называется одним, а респонденту показывает другое, и понять это со стороны портала нельзя.
 *
 * ⚠ Дату публикации ставим ТОЛЬКО при публикации, не при переименовании. Опубликованная
 * версия публиковалась не сегодня, и переписать дату значило бы соврать в единственном поле,
 * по которому потом восстанавливают, когда анкета вышла.
 */
export function buildPublishCall(
  template: SmartProcessRef,
  planned: PlannedPublish,
  publishedAt: Date,
): PortalCall {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: template.entityTypeId,
      id: planned.id,
      useOriginalUfNames: 'Y',
      fields: {
        title: planned.name,
        [buildFieldName(template.id, 'STATE')]: 'published',
        [buildFieldName(template.id, 'SCHEMA')]: JSON.stringify({ ...planned.schema, title: planned.name }),
        ...(planned.action === 'publish'
          ? { [buildFieldName(template.id, 'PUBLISHED_AT')]: publishedAt.toISOString().slice(0, 10) }
          : {}),
      },
    },
  }
}

/**
 * Прочитать, сколько приглашений выпущено по каждой версии и сколько пройдено.
 *
 * ⚠ Просим только три поля: код, версию и состояние. Ответы и баллы здесь не нужны,
 * а `select: ['*']` притащил бы их — то есть тексты, которые писал респондент, в память
 * скрипта, запускаемого с ноутбука оператора. Узкий перечень тут не про вес, а про то,
 * чего мы у себя не держим.
 */
export function buildListSurveysCall(survey: SmartProcessRef, start = 0): PortalCall {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: survey.entityTypeId,
      useOriginalUfNames: 'Y',
      select: [
        buildFieldName(survey.id, 'TEMPLATE_CODE'),
        buildFieldName(survey.id, 'TEMPLATE_VERSION'),
        buildFieldName(survey.id, 'STATE'),
      ],
      ...(start === 0 ? {} : { start }),
    },
  }
}

/** Состояние пройденного опроса. То же слово, что пишет доставка ответа. */
const SURVEY_STATE_COMPLETED = 'completed'

/** Досчитать сводку использования по странице «Опросов». Копится по страницам. */
export function tallySurveyUsage(
  response: unknown,
  survey: SmartProcessRef,
  into: Map<string, VersionUsage> = new Map(),
): Map<string, VersionUsage> {
  const items = (response as { result?: { items?: unknown } } | null)?.result?.items
  if (!Array.isArray(items)) return into

  const codeField = buildFieldName(survey.id, 'TEMPLATE_CODE')
  const versionField = buildFieldName(survey.id, 'TEMPLATE_VERSION')
  const stateField = buildFieldName(survey.id, 'STATE')

  for (const raw of items) {
    const item = raw as Record<string, unknown>
    const code = text(item[codeField])
    const version = Number(item[versionField])
    if (code === '' || !Number.isInteger(version)) continue

    const key = usageKey(code, version)
    const seen = into.get(key) ?? { issued: 0, completed: 0 }
    seen.issued += 1
    if (text(item[stateField]) === SURVEY_STATE_COMPLETED) seen.completed += 1
    into.set(key, seen)
  }

  return into
}

/** Ответ на `crm.item.update`: элемент вернулся — значит правка дошла. */
export function readUpdatedItemId(response: unknown): number | null {
  const id = Number((response as { result?: { item?: { id?: unknown } } } | null)?.result?.item?.id)
  return Number.isInteger(id) && id > 0 ? id : null
}
