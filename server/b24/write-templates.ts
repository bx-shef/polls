import {
  buildCreateTemplateCall,
  buildListVersionsCall,
  DEFAULT_IMPORT_STATE,
  FIRST_IMPORT_VERSION,
  planTemplateWrites,
  readExistingVersions,
  type TemplateState,
  type TemplateWritePlan,
} from '../domain/import/template-write'
import { readCreatedItemId } from '../domain/invitations/portal-calls'
import type { SmartProcessRef } from '../domain/portals/smart-processes'
import type { SurveyTemplate } from '../domain/surveys/model'
import { safeRefusal } from '../domain/answers/portal-errors'
import type { RestCall } from './provision'
import { logger } from '../utils/logger'

/**
 * Writes imported templates into the portal, idempotently, with a dry run that costs nothing.
 *
 * ⚠ СУХОЙ ПРОГОН ЗДЕСЬ НЕ РЕЖИМ, А СЛЕДСТВИЕ УСТРОЙСТВА. План строится чистой функцией
 * по тому, что уже есть на портале; чтобы увидеть, что произойдёт, достаточно не отправлять
 * созданное. Поэтому «посмотреть» и «записать» — это один и тот же код, а не две ветки,
 * которые разъедутся. `docs/PROCESS.md` требует именно этого: «сухой прогон можно повторять
 * сколько угодно раз, пока сверка не сойдётся, и только потом писать».
 *
 * ⚠ Повторный прогон безопасен ПО ПОСТРОЕНИЮ, а не по аккуратности: существующая пара
 * «код + версия» не перезаписывается никогда — опубликованная версия неизменяема.
 */

/**
 * Предел перелистывания списка версий.
 *
 * Не ожидаемый размер, а страховка от бесконечного цикла на кривом `next`. Двенадцать
 * шаблонов — это одна страница; сотня версий за годы правок — две.
 */
const MAX_PAGES = 50

/** Чем кончился перенос. Обе половины идут в отчёт клиенту, а не только успех. */
export interface TemplateWriteResult extends TemplateWritePlan {
  /** Сколько создано. При сухом прогоне ноль, и `create` при этом непустой. */
  written: number
  /** Что не удалось записать: код версии и наш безопасный код отказа. */
  failed: { code: string, version: number, reason: string }[]
  /** Был ли это сухой прогон. В отчёте это первое, что нужно знать. */
  dryRun: boolean
}

/**
 * Перенести шаблоны в портал.
 *
 * ⚠ Одна упавшая запись НЕ обрывает остальные. Тот же приём, что у создания полей
 * (`ensureFields`): перенос из двенадцати анкет, споткнувшийся на второй, оставил бы клиента
 * с четвертью работы и без понятного способа доделать. Собираем отказы и отдаём их отчётом.
 *
 * ⚠ Наружу уходит НАШ код отказа, а не текст портала: Битрикс24 цитирует присланное значение
 * в ошибке валидации, а присланное значение здесь — схема анкеты клиента.
 */
export async function writeTemplates(
  call: RestCall,
  template: SmartProcessRef,
  templates: readonly SurveyTemplate[],
  options: { apply?: boolean, state?: TemplateState, version?: number, now?: Date } = {},
): Promise<TemplateWriteResult> {
  const state = options.state ?? DEFAULT_IMPORT_STATE
  const version = options.version ?? FIRST_IMPORT_VERSION
  const dryRun = options.apply !== true

  const existing = await listExistingVersions(call, template)
  const plan = planTemplateWrites(templates, existing, version)
  const result: TemplateWriteResult = { ...plan, written: 0, failed: [], dryRun }

  if (dryRun) return result

  for (const planned of plan.create) {
    const create = buildCreateTemplateCall(template, planned, state, options.now ?? new Date())
    try {
      if (readCreatedItemId(await call(create.method, create.params)) === null) {
        // Двухсотый ответ без идентификатора означает, что портал принял запрос и ничего
        // не создал. Посчитав это успехом, мы отчитались бы о переносе, которого не было.
        throw new Error('портал не вернул идентификатор элемента')
      }
      result.written += 1
    }
    catch (error) {
      result.failed.push({ code: planned.code, version: planned.version, reason: safeRefusal(error) })
    }
  }

  // ⚠ В журнал уходят СЧЁТЧИКИ и коды анкет, но не схемы и не названия: схема — это текст,
  // который писал клиент, и журналу он не нужен ни при каком разборе.
  logger.info(
    { written: result.written, skipped: plan.skip.length, failed: result.failed.length, state },
    'перенос шаблонов в портал завершён',
  )
  return result
}

/** Все пары «код + версия» с портала, со всех страниц. */
async function listExistingVersions(call: RestCall, template: SmartProcessRef): Promise<Set<string>> {
  const keys = new Set<string>()
  let start: number | null = 0

  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const response = await call(...asArgs(buildListVersionsCall(template, start)))
    for (const key of readExistingVersions(response, template)) keys.add(key)
    start = readNext(response)
  }

  return keys
}

function asArgs(planned: { method: string, params: Record<string, unknown> }): [string, Record<string, unknown>] {
  return [planned.method, planned.params]
}

/** Смещение следующей страницы; `null` — страниц больше нет. */
function readNext(response: unknown): number | null {
  const next = (response as { next?: unknown } | null)?.next
  const offset = Number(next)
  return Number.isInteger(offset) && offset > 0 ? offset : null
}
