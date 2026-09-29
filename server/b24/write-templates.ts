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
import { findTypeByTitle, SURVEY_SP_TITLES, TEMPLATE_SP_TITLES, readFlag, readNextOffset, type SmartProcessRef } from '../domain/portals/smart-processes'
import type { SurveyTemplate } from '../domain/surveys/model'
import { safeRefusal } from '../domain/answers/portal-errors'
import { PortalError } from '../domain/portals/portal-error'
import { listAllTypes, readStoredRefs, type RestCall, type SmartProcessRefs } from './provision'
import { buildItemFieldsCall, buildListCategoriesCall, hasStateField, isStaged, readDefaultCategoryId } from '../domain/portals/stages'
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

/** Наш код отказа: список не дочитан до конца. */
export const PORTAL_LIST_TRUNCATED = 'SHEF_LIST_TRUNCATED'

/** Чем кончился перенос. Обе половины идут в отчёт клиенту, а не только успех. */
export interface TemplateWriteResult extends TemplateWritePlan {
  /** Сколько создано. При сухом прогоне ноль, и `create` при этом непустой. */
  written: number
  /** Что не удалось записать: код версии и наш безопасный код отказа. */
  failed: { code: string, version: number, reason: string }[]
  /** Был ли это сухой прогон. В отчёте это первое, что нужно знать. */
  dryRun: boolean
  /**
   * Пишет ли команда рядом со стадией и старое поле «Состояние» (`writesLegacyState`).
   *
   * ⚠ В отчёт: запись в поле, которое приложение, возможно, читает, — решение, и оператор
   * необратимой операции должен видеть его и в сухом прогоне. Нашёл `/code-review`
   * в закрывающем проходе панели PR #93.
   */
  legacyField: boolean
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
  // Проверка поля — чтение, и она идёт и в сухом прогоне: «посмотреть» и «записать» — один код.
  const legacyField = plan.create.length > 0 && await writesLegacyState(call, template)
  const result: TemplateWriteResult = { ...plan, written: 0, failed: [], dryRun, legacyField }

  if (dryRun) return result

  for (const planned of plan.create) {
    const create = buildCreateTemplateCall(template, planned, state, options.now ?? new Date(), legacyField)
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

/**
 * Whether an operator command writes the old `STATE` field next to the stage: stages are on, and the field still lives.
 *
 * ⚠ ВЕБХУК НЕ ВИДИТ, ЧЕМ ЧИТАЕТ ПРИЛОЖЕНИЕ. Режим приложения — сохранённая ссылка с воронкой,
 * а она лежит в `app.option`, закрытом для вебхука (разбор у `findTemplateProcess`); команда
 * выводит режим из самого типа (`withFunnel`). Расходятся они там, где стадии включены, а
 * приложение читает старое поле: у усыновлённого смарт-процесса, чьи стадии администратор включил
 * сам уже после миграции, у тарифа, открывшего стадии позже, в час между включением стадий
 * и сохранением воронки. Запиши команда там одну стадию, приложение прочитало бы опубликованную
 * анкету черновиком. Поэтому, пока старое поле живо, команда пишет и его: оба режима приложения читают такую
 * запись одинаково, а перенос, если он ещё впереди, снимет поле сам. Нашёл `/code-review`
 * в панели PR #93.
 *
 * ⚠ Поле ищется, а не пишется наугад, хотя запись в несуществующее поле портал принимает молча
 * (замерено 28.09): молчаливое согласие портала — не контракт, а по коду должно быть видно,
 * когда команда пишет в старое поле. Ищется правом `crm` (`buildItemFieldsCall`) — одним вызовом
 * на прогон команды.
 */
export async function writesLegacyState(call: RestCall, template: SmartProcessRef): Promise<boolean> {
  if (!isStaged(template)) return false
  const probe = buildItemFieldsCall(template)
  return hasStateField(await call(probe.method, probe.params), template)
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

  // Та же причина — и для предела страниц: упёршись в него, мы молча вернули бы неполный список
  // и записали бы дубликат версии с непрочитанной страницы (`/review` и `/code-review` в PR #113).
  if (start !== null) throw new PortalError(PORTAL_LIST_TRUNCATED, `список версий не дочитан за ${MAX_PAGES} страниц`)
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
  return (await findProcesses(call)).template ?? null
}

/**
 * Найти ОБА смарт-процесса за один обход.
 *
 * ⚠ Одно перечисление типов, а не два. Раздельный поиск делал в вебхучном режиме — то есть
 * в единственном задокументированном — два отказавших `app.option.get` и два полных
 * перелистывания `crm.type.list` подряд, до первой полезной работы и под троттлингом портала
 * клиента. Нашёл `/code-review` в PR #50.
 */
export async function findProcesses(call: RestCall): Promise<Partial<SmartProcessRefs>> {
  try {
    const stored = await readStoredRefs(call)
    if (stored.template !== undefined && stored.survey !== undefined) return stored
  }
  catch {
    // Вебхук: контекста приложения нет. Это не беда, а другой способ доступа.
  }

  const types = await listAllTypes(call)
  return {
    template: await withFunnel(call, types, findTypeByTitle(types, TEMPLATE_SP_TITLES)),
    survey: await withFunnel(call, types, findTypeByTitle(types, SURVEY_SP_TITLES)),
  }
}

/**
 * Adds the default funnel to a found smart process whose native stages are on.
 *
 * ⚠ Вебхуку сохранённые ссылки недоступны, а с ними и признак «на стадиях» (`categoryId`), который
 * ставит миграция ревизии 5. Поэтому здесь он выводится из самого типа: стадии включены — пишем
 * и читаем стадией. Иначе команда переноса записала бы состояние в поле, которого после миграции
 * нет, — портал молча отбросил бы его, и анкета осталась бы «Черновиком».
 */
async function withFunnel(
  call: RestCall,
  types: readonly Record<string, unknown>[],
  ref: SmartProcessRef | null,
): Promise<SmartProcessRef | undefined> {
  if (ref === null) return undefined
  const type = types.find(one => Number(one.id) === ref.id)
  // ⚠ Флаг портал отдаёт и `'Y'`, и `true` (разбор у `readFlag`): сравнив только с `'Y'`, команда
  // на `true` молча вернулась бы к удалённому полю. Нашёл `/review` в панели PR #93.
  if (readFlag(type?.isStagesEnabled) !== true) return ref
  // Пока старое поле живо, команда пишет и его — рядом со стадией (`writesLegacyState`): так её
  // запись одинаково читают оба режима приложения и перенос. Своё чтение команды от режима не зависит
  // там, где оно решает необратимое: опубликованной она считает и версию с одной датой
  // (`planTemplatePublish`).
  const list = buildListCategoriesCall(ref)
  const categoryId = readDefaultCategoryId(await call(list.method, list.params))
  if (categoryId === null) {
    // Стадии включены, а воронки портал не назвал — писать стадией нечем, пишем полем. Громко:
    // после миграции поля может не быть, и запись в него портал молча отбросит (замерено 28.09).
    logger.warn({ typeId: ref.id }, 'стадии включены, но воронка по умолчанию не найдена — команда пишет старым полем')
    return ref
  }
  return { ...ref, categoryId }
}
