import { buildFieldName } from '../portals/smart-processes'
import type { PortalCall, SmartProcessRef } from '../portals/smart-processes'
import type { SurveyTemplate } from '../surveys/model'

/**
 * Writing imported survey templates into the portal's «Шаблон опроса» smart process.
 *
 * ⚠ Это последнее недостающее звено цепочки: без него на портале ноль анкет, выпускать
 * нечего, и весь путь проверяется только на тех шаблонах, что завели руками
 * (`docs/PROJECT_MAP.md`, «Что мешает выпуску»).
 *
 * Здесь только чистые функции: план записи и сборка вызовов. Отправляет их интеграция —
 * домен про REST не знает.
 */

/** Состояние записываемой версии. Те же слова, что читает `readPublishedTemplates`. */
export type TemplateState = 'draft' | 'published'

/**
 * Состояние по умолчанию — ЧЕРНОВИК, и это прямое следствие того, что сказал снимок.
 *
 * ⚠ Названий анкет в источнике НЕТ вовсе: `questionary_list` хранит коды и имена классов,
 * человеческих названий ни одного (см. `docs/PROCESS.md`, раздел 16а). Значит сразу после
 * переноса все двенадцать шаблонов называются своими кодами — `brand`, `concept`, `design`.
 *
 * А опубликованная версия у нас НЕИЗМЕНЯЕМА — это инвариант проекта. Записав перенос сразу
 * опубликованным, мы заморозили бы двенадцать анкет с машинными именами навсегда: переименовать
 * нельзя, остаётся выпускать тринадцатую версию поверх. Черновик даёт владельцу назвать их
 * по-человечески и опубликовать уже осмысленными.
 */
export const DEFAULT_IMPORT_STATE: TemplateState = 'draft'

/** Номер версии для первого переноса. Правка породит следующую — так устроены версии. */
export const FIRST_IMPORT_VERSION = 1

/** Ключ версии: пара «код + номер», по которой ищется уже записанное. */
export function versionKey(code: string, version: number): string {
  return `${code}@${version}`
}

/**
 * Прочитать пары «код + версия», которые на портале уже есть.
 *
 * Схему НЕ запрашиваем: она здесь не нужна, а весит больше всего остального вместе взятого —
 * двенадцать схем это десятки килобайт в ответе, который читается ради двух полей.
 */
export function buildListVersionsCall(template: SmartProcessRef, start = 0): PortalCall {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: template.entityTypeId,
      useOriginalUfNames: 'Y',
      select: ['id', buildFieldName(template.id, 'CODE'), buildFieldName(template.id, 'VERSION')],
      ...(start === 0 ? {} : { start }),
    },
  }
}

/** Ключи версий из ответа. Неразборчивые строки пропускаются: их не с чем сравнивать. */
export function readExistingVersions(response: unknown, template: SmartProcessRef): Set<string> {
  const items = (response as { result?: { items?: unknown } } | null)?.result?.items
  if (!Array.isArray(items)) return new Set()

  const codeField = buildFieldName(template.id, 'CODE')
  const versionField = buildFieldName(template.id, 'VERSION')
  const keys = new Set<string>()

  for (const raw of items) {
    const item = raw as Record<string, unknown>
    const code = typeof item[codeField] === 'string' ? item[codeField] : ''
    const version = Number(item[versionField])
    if (code === '' || !Number.isInteger(version) || version <= 0) continue
    keys.add(versionKey(code, version))
  }

  return keys
}

/** Одна версия, которую предстоит записать. */
export interface PlannedTemplate {
  code: string
  version: number
  title: string
  schema: SurveyTemplate
}

/** Версия, которую записывать не будем, и почему. */
export interface SkippedTemplate {
  code: string
  version: number
  reason: string
}

/** План записи: что создаём и что пропускаем. Обе половины нужны отчёту о переносе. */
export interface TemplateWritePlan {
  create: PlannedTemplate[]
  skip: SkippedTemplate[]
}

/**
 * Что записывать, а что уже есть.
 *
 * ⚠ СУЩЕСТВУЮЩАЯ ВЕРСИЯ НЕ ПЕРЕЗАПИСЫВАЕТСЯ НИКОГДА. Это инвариант проекта: опубликованная
 * версия неизменяема, правка порождает новую. Повторный прогон переноса поэтому безопасен
 * по построению — он ничего не трогает, а не «трогает аккуратно».
 *
 * ⚠ И не пишет вторую версию вместо первой. Соблазн есть: «код занят — положим версией 2».
 * Но повторный прогон переноса — это не правка анкеты, а тот же самый перенос; версией 2
 * мы бы удвоили каждый шаблон при каждом запуске, и через три прогона у клиента было бы
 * тридцать шесть анкет вместо двенадцати.
 *
 * ⚠ Название берётся из схемы, а у переноса его там нет — остаётся код. Так и записываем,
 * честно: придумать за клиента названия его анкет мы не можем, а пустое название хуже кода.
 * Отчёт о переносе обязан сказать, что их надо назвать.
 */
export function planTemplateWrites(
  templates: readonly SurveyTemplate[],
  existing: ReadonlySet<string>,
  version: number = FIRST_IMPORT_VERSION,
): TemplateWritePlan {
  const plan: TemplateWritePlan = { create: [], skip: [] }
  const seen = new Set<string>()

  for (const schema of templates) {
    const key = versionKey(schema.code, version)

    if (existing.has(key)) {
      plan.skip.push({ code: schema.code, version, reason: 'такая версия на портале уже есть' })
      continue
    }
    if (seen.has(key)) {
      // Два шаблона с одним кодом в одном снимке — это поломка источника, а не наш случай.
      // Записав оба, мы сделали бы выпуск ссылки неоднозначным: какой из них выберет вкладка.
      plan.skip.push({ code: schema.code, version, reason: 'код повторяется внутри снимка' })
      continue
    }

    seen.add(key)
    plan.create.push({
      code: schema.code,
      version,
      title: schema.title === '' ? schema.code : schema.title,
      schema,
    })
  }

  return plan
}

/**
 * Создать элемент «Шаблон опроса».
 *
 * ⚠ `PUBLISHED_AT` заполняется ТОЛЬКО у опубликованной версии. У черновика его нет, и это
 * не пропуск: дата публикации черновика — противоречие, а пустое поле честно говорит
 * «ещё не публиковали».
 */
export function buildCreateTemplateCall(
  template: SmartProcessRef,
  planned: PlannedTemplate,
  state: TemplateState,
  publishedAt: Date,
): PortalCall {
  return {
    method: 'crm.item.add',
    params: {
      entityTypeId: template.entityTypeId,
      useOriginalUfNames: 'Y',
      fields: {
        title: planned.title,
        [buildFieldName(template.id, 'CODE')]: planned.code,
        [buildFieldName(template.id, 'VERSION')]: planned.version,
        [buildFieldName(template.id, 'STATE')]: state,
        // Схема уезжает строкой: поле текстовое, и `readPublishedTemplates` разбирает её
        // обратно из строки. Отдав объект, мы полагались бы на то, что портал сериализует
        // его так же, как мы ожидаем прочитать.
        [buildFieldName(template.id, 'SCHEMA')]: JSON.stringify(planned.schema),
        ...(state === 'published'
          ? { [buildFieldName(template.id, 'PUBLISHED_AT')]: publishedAt.toISOString().slice(0, 10) }
          : {}),
      },
    },
  }
}
