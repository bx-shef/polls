import {
  buildCreateTemplateCall,
  buildListVersionsCall,
  DEFAULT_IMPORT_STATE,
  planTemplateWrites,
  readExistingVersions,
  type TemplateState,
  type TemplateWritePlan,
} from '../domain/import/template-write'
import { readCreatedItemId } from '../domain/invitations/portal-calls'
import { findTypeByTitle, TEMPLATE_SP_TITLE, readNextOffset, type SmartProcessRef } from '../domain/portals/smart-processes'
import type { SurveyTemplate } from '../domain/surveys/model'
import { safeRefusal } from '../domain/answers/portal-errors'
import { PortalError } from '../domain/portals/portal-error'
import { listAllTypes, readStoredRefs, type RestCall } from './provision'
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

/** Наш код отказа: портал ответил успехом, но элемента не создал. */
export const PORTAL_CREATED_NOTHING = 'SHEF_CREATED_NOTHING'

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
  options: { apply?: boolean, state?: TemplateState, now?: Date } = {},
): Promise<TemplateWriteResult> {
  const state = options.state ?? DEFAULT_IMPORT_STATE
  const dryRun = options.apply !== true

  const existing = await listExistingVersions(call, template)
  const plan = planTemplateWrites(templates, existing)
  const result: TemplateWriteResult = { ...plan, written: 0, failed: [], dryRun }

  if (dryRun) return result

  for (const planned of plan.create) {
    const create = buildCreateTemplateCall(template, planned, state, options.now ?? new Date())
    try {
      if (readCreatedItemId(await call(create.method, create.params)) === null) {
        // ⚠ Двухсотый ответ без идентификатора означает, что портал принял запрос и ничего
        // не создал. Посчитав это успехом, мы отчитались бы о переносе, которого не было.
        //
        // ⚠ Бросаем `PortalError` С КОДОМ, а не голый `Error`: `safeRefusal` знает закрытый
        // список кодов и любую незнакомую строку схлопывает в «код не распознан». То есть
        // специально написанный диагноз доезжал до оператора неотличимым от сетевой беды.
        // Нашла панель ревью.
        throw new PortalError(PORTAL_CREATED_NOTHING, 'портал принял запрос и ничего не создал')
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

  // ⚠ Отказ на любой странице роняет весь перенос, и это осознанно: с неполным списком
  // существующих версий продолжать нельзя — мы создали бы дубликат той, что лежит
  // на непрочитанной странице.
  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const list = buildListVersionsCall(template, start)
    const response = await call(list.method, list.params)
    for (const key of readExistingVersions(response, template)) keys.add(key)
    start = readNextOffset(response)
  }

  return keys
}

/**
 * Найти смарт-процесс «Шаблон опроса» так, как это может входящий вебхук.
 *
 * ⚠ ВЕБХУК НЕ ВИДИТ `app.option`. Проверено на живом портале: `app.option.get` отвечает
 * `ACCESS_DENIED: Access denied! Application context required` — это хранилище приложения,
 * а у входящего вебхука контекста приложения нет по определению. Наши идентификаторы
 * смарт-процессов лежат именно там, то есть обычный путь чтения ссылок вебхуку закрыт.
 *
 * Поэтому: сначала пробуем прочитать сохранённое (сработает, когда вызов идёт токенами
 * приложения), при отказе — ищем по заголовку. Поиск по заголовку в проекте уже есть
 * и написан ровно для этого случая («идентификатор потерян, смарт-процесс на портале
 * остался»); здесь он переиспользуется, а не пишется заново.
 *
 * ⚠ Заголовок — не признак владения: совпасть может смарт-процесс, который клиент завёл
 * руками. Для переноса это приемлемо, потому что оператор видит отчёт до записи и сухой
 * прогон покажет, во что собирается писать. Для приложения — нет, и там этот путь
 * помечается «усыновлением» и уходит в журнал предупреждением.
 */
export async function findTemplateProcess(call: RestCall): Promise<SmartProcessRef | null> {
  try {
    const stored = await readStoredRefs(call)
    if (stored.template !== undefined) return stored.template
  }
  catch {
    // Вебхук: контекста приложения нет. Это не беда, а другой способ доступа.
  }

  return findTypeByTitle(await listAllTypes(call), TEMPLATE_SP_TITLE)
}
