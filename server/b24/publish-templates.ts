import {
  buildListAllTemplatesCall,
  buildListSurveysCall,
  buildPublishCall,
  planTemplatePublish,
  readTemplateItems,
  readUpdatedItemId,
  tallySurveyUsage,
  type PortalTemplateItem,
  type TemplatePublishPlan,
  type VersionUsage,
} from '../domain/import/template-publish'
import { readNextOffset, type SmartProcessRef } from '../domain/portals/smart-processes'
import { safeRefusal } from '../domain/answers/portal-errors'
import { PortalError } from '../domain/portals/portal-error'
import type { RestCall } from './provision'
import { logger } from '../utils/logger'

/**
 * Publishes named drafts, idempotently, with a dry run that costs nothing.
 *
 * Тот же приём, что у переноса (`write-templates.ts`), и намеренно тот же: план строит чистая
 * функция по тому, что лежит на портале, а «посмотреть» и «опубликовать» — один и тот же код.
 * Публикация необратима по инварианту проекта, поэтому цена сухого прогона здесь ещё ниже цены
 * ошибки, чем при переносе.
 */

/** Предел перелистывания. Страховка от кривого `next`, а не ожидаемый размер. */
const MAX_PAGES = 50

/** Наш код отказа: список не дочитан до конца. */
export const PORTAL_LIST_TRUNCATED = 'SHEF_LIST_TRUNCATED'

/** Наш код отказа: портал ответил успехом, но элемент не вернул. */
export const PORTAL_UPDATED_NOTHING = 'SHEF_UPDATED_NOTHING'

/** Чем кончилась публикация. */
export interface TemplatePublishResult extends TemplatePublishPlan {
  /** Сколько опубликовано. При сухом прогоне ноль, и `publish` при этом непустой. */
  published: number
  /** Что не удалось: код версии и наш безопасный код отказа. */
  failed: { code: string, version: number, reason: string }[]
  /** Был ли это сухой прогон. */
  dryRun: boolean
}

/**
 * Опубликовать названные черновики.
 *
 * ⚠ Одна упавшая публикация НЕ обрывает остальные — как и при переносе. Споткнувшись
 * на второй из двенадцати, мы оставили бы владельца с половиной опубликованных анкет
 * и без понятного способа доделать.
 */
export async function publishTemplates(
  call: RestCall,
  template: SmartProcessRef,
  survey: SmartProcessRef,
  options: { apply?: boolean, now?: Date } = {},
): Promise<TemplatePublishResult> {
  const dryRun = options.apply !== true

  const items = await listAllItems(call, template)
  const usage = await tallyUsage(call, survey)
  const plan = planTemplatePublish(items, usage)
  const result: TemplatePublishResult = { ...plan, published: 0, failed: [], dryRun }

  if (dryRun) return result

  for (const planned of plan.publish) {
    const update = buildPublishCall(template, planned, options.now ?? new Date())
    try {
      if (readUpdatedItemId(await call(update.method, update.params)) === null) {
        // Двухсотый ответ без элемента означает, что портал принял запрос и ничего не изменил.
        // Код — свой, а не голая строка: `safeRefusal` знает закрытый список и незнакомую
        // схлопывает в «код не распознан».
        throw new PortalError(PORTAL_UPDATED_NOTHING, 'портал принял запрос и ничего не изменил')
      }
      result.published += 1
    }
    catch (error) {
      result.failed.push({ code: planned.code, version: planned.version, reason: safeRefusal(error) })
    }
  }

  // ⚠ В журнал уходят СЧЁТЧИКИ, но не названия анкет: название придумал клиент, и журналу
  // оно не нужно ни при каком разборе.
  logger.info(
    { published: result.published, skipped: plan.skip.length, failed: result.failed.length },
    'публикация шаблонов завершена',
  )
  return result
}

/**
 * Сводка: сколько приглашений выпущено по каждой версии и сколько пройдено.
 *
 * ⚠ Отказ здесь роняет публикацию целиком, и это осознанно. Без сводки мы не отличили бы
 * версию, которую никто не проходил, от той, по которой уже собрана статистика, — то есть
 * могли бы переименовать вторую. Пустая сводка выглядела бы как «никто не проходил»
 * и разрешила бы ровно то, что запрещает инвариант.
 */
async function tallyUsage(call: RestCall, survey: SmartProcessRef): Promise<Map<string, VersionUsage>> {
  const usage = new Map<string, VersionUsage>()
  let start: number | null = 0

  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const list = buildListSurveysCall(survey, start)
    const response = await call(list.method, list.params)
    tallySurveyUsage(response, survey, usage)
    start = readNextOffset(response)
  }

  // ⚠ ДОЧИТАЛИ ИЛИ НЕ ЗАПУСКАЕМСЯ. Упёршись в предел, мы получили бы сводку без последних
  // страниц — а неполная сводка тут не «менее точная», она ОПАСНАЯ: версия, чьи пройденные
  // опросы лежат на непрочитанной странице, выглядит как «никто не проходил» и открывает
  // переименование, которое инвариант запрещает. Молчать об этом нельзя.
  // Нашёл `/code-review` в PR #50.
  if (start !== null) {
    throw new PortalError(
      PORTAL_LIST_TRUNCATED,
      `список «Опросов» не дочитан за ${MAX_PAGES} страниц — сводка по пройденным была бы неполной`,
    )
  }

  return usage
}

/** Все элементы «Шаблона опроса», со всех страниц. */
async function listAllItems(call: RestCall, template: SmartProcessRef): Promise<PortalTemplateItem[]> {
  const items: PortalTemplateItem[] = []
  let start: number | null = 0

  // ⚠ Отказ на любой странице роняет публикацию целиком: с неполным списком отчёт сказал бы
  // «опубликовано двенадцать из двенадцати», умолчав о тринадцатой на непрочитанной странице.
  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const list = buildListAllTemplatesCall(template, start)
    const response = await call(list.method, list.params)
    items.push(...readTemplateItems(response, template))
    start = readNextOffset(response)
  }

  // Та же причина, что и у сводки: недочитанный список молча теряет шаблоны, а отчёт
  // при этом выглядит полным. К тому же проверка дубликатов пары «код + версия» на неполном
  // списке просто не сработает — вторая карточка окажется на непрочитанной странице.
  if (start !== null) {
    throw new PortalError(
      PORTAL_LIST_TRUNCATED,
      `список шаблонов не дочитан за ${MAX_PAGES} страниц`,
    )
  }

  return items
}
