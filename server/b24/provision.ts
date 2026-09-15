import {
  buildCreateSmartProcessCall,
  findTypeByTitle,
  planMissingFields,
  readCreatedRef,
  readFieldNames,
  readNextOffset,
  readTypes,
  SURVEY_FIELDS,
  SURVEY_SP_TITLE,
  TEMPLATE_FIELDS,
  TEMPLATE_SP_TITLE,
  buildFieldEntityId,
  type SmartProcessField,
  type SmartProcessRef,
} from '../domain/portals/smart-processes'

/**
 * Creates the two smart processes and their fields in a portal, idempotently.
 *
 * Всё строится поверх внедрённого `call`, поэтому проверяется тестом с подделкой, без сети.
 * Форма взята у `client-bank-alfa-by` (`server/utils/distributionSpProvision.ts`).
 *
 * ⚠ Вызывающий обязан обеспечить, что для одного портала это выполняется в один поток.
 * Блокировки здесь нет: два одновременных запуска оба не найдут смарт-процесс по заголовку
 * и создадут дубликат, а лимит на Базовом тарифе — 150 на весь портал. Установка приходит
 * одним событием, так что сегодня это выполняется само.
 */

/** Минимальный вызов портала. Реализация — SDK-клиент, привязанный к порталу. */
export type RestCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Ключ в `app.option`, под которым портал хранит идентификаторы наших смарт-процессов. */
export const SP_REFS_OPTION = 'shef_survey_sp'

/**
 * Предел перелистывания.
 *
 * Не ожидаемый размер, а страховка от бесконечного цикла, если портал вернёт кривой `next`.
 * Сто страниц по пятьдесят — это пять тысяч смарт-процессов при лимите тарифа в тысячу.
 */
const MAX_PAGES = 100

export interface SmartProcessRefs {
  template: SmartProcessRef
  survey: SmartProcessRef
}

export interface ProvisionResult extends SmartProcessRefs {
  createdTemplate: boolean
  createdSurvey: boolean
  /** Сколько полей создано этим запуском. Ноль — всё уже было на месте. */
  addedFields: number
}

/**
 * Есть ли у пользователя, от имени которого пришёл токен, права администратора.
 *
 * Проверяется при установке, а не когда метод понадобился: без этих прав не создать
 * ни смарт-процесс, ни поле, ни записать настройки (`app.option.set` отвечает
 * «Administrator authorization required»). Узнать об этом в момент, когда сотрудник
 * уже ждёт ссылку, — худший из вариантов.
 */
export async function isPortalAdmin(call: RestCall): Promise<boolean> {
  const response = await call('user.admin') as { result?: unknown } | null
  return response?.result === true
}

/** Прочитать сохранённые на портале идентификаторы. Портал — источник истины, не мы. */
export async function readStoredRefs(call: RestCall): Promise<Partial<SmartProcessRefs>> {
  const response = await call('app.option.get', { option: SP_REFS_OPTION }) as { result?: unknown } | null
  const raw = response?.result
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed = JSON.parse(raw) as Partial<SmartProcessRefs>
    return { template: validRef(parsed.template), survey: validRef(parsed.survey) }
  }
  catch {
    // Испорченное значение не должно мешать установке: не прочитали — значит найдём
    // смарт-процессы по заголовку и перезапишем.
    return {}
  }
}

/** Записать идентификаторы на портал. Требует прав администратора. */
export async function storeRefs(call: RestCall, refs: SmartProcessRefs): Promise<void> {
  await call('app.option.set', { options: { [SP_REFS_OPTION]: JSON.stringify(refs) } })
}

function validRef(ref: SmartProcessRef | undefined): SmartProcessRef | undefined {
  if (ref === undefined) return undefined
  const ok = Number.isInteger(ref.entityTypeId) && ref.entityTypeId > 0
    && Number.isInteger(ref.id) && ref.id > 0
  return ok ? ref : undefined
}

/** Все смарт-процессы портала, со всех страниц. */
async function listAllTypes(call: RestCall): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const response = await call('crm.type.list', start === 0 ? {} : { start })
    all.push(...readTypes(response))
    start = readNextOffset(response)
  }
  return all
}

/** Имена всех полей смарт-процесса, со всех страниц. */
async function listAllFieldNames(call: RestCall, spTypeId: number): Promise<string[]> {
  const names: string[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const params: Record<string, unknown> = { moduleId: 'crm', filter: { entityId: buildFieldEntityId(spTypeId) } }
    if (start !== 0) params.start = start
    const response = await call('userfieldconfig.list', params)
    names.push(...readFieldNames(response))
    start = readNextOffset(response)
  }
  return names
}

/**
 * Найти или создать один смарт-процесс.
 *
 * Порядок: сохранённый идентификатор → поиск по заголовку → создание. Средний шаг
 * не для красоты: приложение переустановили, `app.option` почистили, а смарт-процесс
 * на портале остался — без поиска мы создали бы второй и съели лимит тарифа.
 */
async function ensureSmartProcess(
  call: RestCall,
  known: SmartProcessRef | undefined,
  types: readonly Record<string, unknown>[],
  title: string,
): Promise<{ ref: SmartProcessRef, created: boolean }> {
  if (known !== undefined) return { ref: known, created: false }

  const found = findTypeByTitle(types, title)
  if (found !== null) return { ref: found, created: false }

  const create = buildCreateSmartProcessCall(title)
  const ref = readCreatedRef(await call(create.method, create.params))
  if (ref === null) {
    throw new Error(`crm.type.add не вернул идентификаторы для «${title}»`)
  }
  return { ref, created: true }
}

/**
 * Создать недостающие поля смарт-процесса.
 *
 * ⚠ Одно упавшее поле НЕ обрывает остальные. Прежде у соседа цикл падал на первой ошибке,
 * и поля, стоящие в списке ниже, не создавались никогда. Здесь пробуем все запланированные,
 * собираем ошибки и бросаем сводную — так и частичный отказ не прячется под успехом,
 * и одно поле не блокирует прочие.
 */
async function ensureFields(
  call: RestCall,
  ref: SmartProcessRef,
  fields: readonly SmartProcessField[],
): Promise<number> {
  const existing = await listAllFieldNames(call, ref.id)
  const planned = planMissingFields(ref.id, fields, existing)
  const failures: string[] = []
  let added = 0

  for (const plan of planned) {
    try {
      // Последовательно, без батча: троттлинг портала считает вызовы, а не запросы,
      // и выигрыш батча здесь не стоит усложнения разбора частичных ошибок.
      await call(plan.method, plan.params)
      added++
    }
    catch (error) {
      const field = (plan.params.field as { fieldName?: unknown }).fieldName
      failures.push(`${String(field)}: ${(error as Error).message}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`не создано полей: ${failures.length} из ${planned.length} — ${failures.join('; ')}`)
  }
  return added
}

/**
 * Создать или до-лечить оба смарт-процесса и их поля.
 *
 * Идемпотентно: повторный запуск на готовом портале не делает ни одного изменяющего вызова.
 * `known` позволяет пропустить поиск для того, чей идентификатор уже сохранён.
 */
export async function provisionSmartProcesses(
  call: RestCall,
  known: Partial<SmartProcessRefs> = {},
): Promise<ProvisionResult> {
  // Список запрашиваем, только если хоть один идентификатор неизвестен, — и один раз на оба.
  const types = known.template !== undefined && known.survey !== undefined ? [] : await listAllTypes(call)

  const template = await ensureSmartProcess(call, known.template, types, TEMPLATE_SP_TITLE)
  const survey = await ensureSmartProcess(call, known.survey, types, SURVEY_SP_TITLE)

  const addedTemplate = await ensureFields(call, template.ref, TEMPLATE_FIELDS)
  const addedSurvey = await ensureFields(call, survey.ref, SURVEY_FIELDS)

  return {
    template: template.ref,
    survey: survey.ref,
    createdTemplate: template.created,
    createdSurvey: survey.created,
    addedFields: addedTemplate + addedSurvey,
  }
}
