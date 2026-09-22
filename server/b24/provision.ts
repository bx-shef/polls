import { safeRefusal } from '../domain/answers/portal-errors'
import { logger } from '../utils/logger'
import {
  buildBindDealTabCall,
  buildDealTabHandlerUrl,
  buildUnbindDealTabCall,
  isPlacementAlreadyBound,
} from '../domain/portals/placements'
import {
  buildCreateSmartProcessCall,
  buildReadCardConfigCall,
  buildReadTypeCall,
  buildSetCardConfigCall,
  buildUpdateRelationsCall,
  hasCardConfig,
  findTypeByTitle,
  planDealRelation,
  readTypeRelations,
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
 *
 * ⚠ Вызывающий обязан обернуть `call` в `withDeadline`. Холодная установка — это 17–19
 * последовательных вызовов под троттлингом SDK; без общего предела одна медленная сеть
 * держит HTTP-запрос установки до таймаута прокси. Предел на один вызов есть в клиенте,
 * но он не ограничивает цепочку целиком.
 */

/** Минимальный вызов портала. Реализация — SDK-клиент, привязанный к порталу. */
export type RestCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * Обернуть вызов общим бюджетом времени на всю цепочку.
 *
 * Предел одного вызова живёт в клиенте, но обустройство делает их полтора десятка подряд:
 * девятнадцать вызовов по девятнадцать секунд — это шесть минут в одном HTTP-запросе,
 * которого давно уже никто не ждёт. Здесь бюджет проверяется ПЕРЕД каждым вызовом, то есть
 * цикл действительно останавливается, а не просто перестаёт ждать ответа. Исчерпание —
 * обычная ошибка: она поднимется до `install.post.ts`, портал уйдёт в `degraded`,
 * а уже созданные смарт-процессы найдутся при следующем запуске по заголовку.
 */
export function withDeadline(call: RestCall, budgetMs: number, now: () => number = Date.now): RestCall {
  const deadline = now() + budgetMs
  return async (method, params) => {
    if (now() >= deadline) {
      throw new Error(`обустройство прервано по общему пределу ${budgetMs} мс, не дойдя до ${method}`)
    }
    return call(method, params)
  }
}

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
  /**
   * Смарт-процесс не создан нами, а найден на портале по заголовку.
   *
   * Вызывающий обязан это залогировать: заголовки «Опрос» и «Шаблон опроса» — обычные
   * слова, и совпасть может чужой смарт-процесс, заведённый клиентом руками. Отличить
   * его от нашего, потерявшего идентификатор, нечем — а дальше мы допишем в него свои
   * поля. Пока признака владения нет, единственная защита — видимый след в журнале.
   */
  adoptedTemplate: boolean
  adoptedSurvey: boolean
  /** Сколько полей создано этим запуском. Ноль — всё уже было на месте. */
  addedFields: number
  /**
   * Стоит ли у «Опроса» связь со сделкой.
   *
   * ⚠ `false` означает, что приложение установлено, но главного не делает: элемент «Опрос»
   * не привяжется к сделке, и итог не вернётся в карточку. Установку это не роняет —
   * тариф клиента может запрещать правку смарт-процессов, — но вызывающий обязан это
   * залогировать. Ровно этот исход месяц был невидимым.
   */
  dealLinked: boolean
  /** Разложили ли мы карточку «Опроса». `false` — там уже была своя раскладка либо не вышло. */
  cardConfigured: boolean
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
export async function listAllTypes(call: RestCall): Promise<Record<string, unknown>[]> {
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
 *
 * ⚠ Средний шаг и есть слабое место: заголовок — не признак владения. Совпавший
 * смарт-процесс может оказаться чужим, и тогда мы допишем в него свои поля. Поэтому
 * такой исход помечается `adopted` и обязан быть виден в журнале — см. `ProvisionResult`.
 */
async function ensureSmartProcess(
  call: RestCall,
  known: SmartProcessRef | undefined,
  types: readonly Record<string, unknown>[],
  title: string,
): Promise<{ ref: SmartProcessRef, created: boolean, adopted: boolean }> {
  if (known !== undefined) return { ref: known, created: false, adopted: false }

  const found = findTypeByTitle(types, title)
  if (found !== null) return { ref: found, created: false, adopted: true }

  const create = buildCreateSmartProcessCall(title)
  const ref = readCreatedRef(await call(create.method, create.params))
  if (ref === null) {
    throw new Error(`crm.type.add не вернул идентификаторы для «${title}»`)
  }
  return { ref, created: true, adopted: false }
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
 * Сделать «Опрос» дочерним к сделке.
 *
 * ⚠ БЕЗ ЭТОГО ШАГА НЕ РАБОТАЕТ ВСЁ, РАДИ ЧЕГО ПРИЛОЖЕНИЕ СУЩЕСТВУЕТ. У смарт-процесса
 * поля `parentId2` не появляется само: `isClientEnabled` даёт Контакт и Компанию, а Сделку
 * надо завести отдельно, `relations.parent`. Пока шага не было, `crm.item.add` молча
 * игнорировал `parentId2`, элемент «Опрос» оставался без сделки, и комментарий с итогом
 * не приходил в карточку НИКОГДА. Нашлось первым сквозным прогоном на живом портале:
 * ответ доезжал, а в журнале потом стояло `parentFields: []` — портал не вернул ни одного
 * поля связи, потому что их и не было.
 *
 * Идемпотентно: сначала читаем, и пишем только если сделки среди родителей нет. На здоровом
 * портале это один читающий вызов и ноль изменяющих — то, что обещает `provisionSmartProcesses`.
 *
 * ⚠ Одного пути хватает на оба случая, и второго заводить не надо. Соблазн передать
 * `relations` прямо в `crm.type.add` велик — это сэкономило бы вызов на свежей установке,
 * — но тогда настройка живёт в двух местах и расходится ровно тогда, когда правят одно.
 * Существующие порталы всё равно чинятся только этим шагом.
 *
 * Возвращает, стоит ли связь. `false` установку НЕ роняет: без связи приложение остаётся
 * рабочим в остальном, а тариф клиента может просто запрещать правку смарт-процессов
 * (`UPDATE_DYNAMIC_TYPE_RESTRICTED`). Но исход обязан быть виден — молчащий отказ здесь
 * и есть та беда, которую мы только что чинили.
 */
export async function ensureDealRelation(call: RestCall, ref: SmartProcessRef): Promise<boolean> {
  const read = buildReadTypeCall(ref)
  const current = readTypeRelations(await call(read.method, read.params))
  if (current === null) {
    // ⚠ Молчать здесь нельзя, и это не формальность. Отказ читается как `dealLinked: false`,
    // неотличимо от «тариф не позволил» и от «портал не ответил», — а причина у него своя
    // и чинится по-другому: среди связей клиента есть запись, формы которой мы не узнали,
    // и мы намеренно не трогаем настройки, чтобы её не стереть (`readTypeRelations`).
    // Без этой строки владелец видел бы «связь не настроена» и не знал бы, что делать.
    logger.warn({}, 'связь со сделкой не тронута: настройки связей на портале не разобраны целиком')
    return false
  }

  const planned = planDealRelation(current)
  if (planned === null) return true

  const update = buildUpdateRelationsCall(ref, planned)
  const relations = readTypeRelations(await call(update.method, update.params))

  // ⚠ Проверяем ОТВЕТ, а не факт отсутствия исключения. Двухсотый ответ без связи в списке
  // означал бы, что портал принял запрос и ничего не сделал, — и мы отчитались бы об успехе
  // ровно там, где до этого месяц молчали.
  return relations !== null && planDealRelation(relations) === null
}

/**
 * Разложить карточку «Опроса» так, чтобы в ней было видно главное.
 *
 * ⚠ Только на ПУСТОМ месте. `crm.item.details.configuration.set` перезаписывает раскладку
 * целиком и сразу для всех пользователей — это настройка клиента, а не наша. Разложивший
 * карточку под себя получал бы нашу при каждой переустановке; такого мы уже натворили бы
 * со связями, если бы не сливали их. Поэтому сначала читаем, и ставим, только если пусто.
 *
 * Возвращает, стоит ли раскладка нашей. `false` здесь — и «не поставили», и «там уже своя»:
 * различать их незачем, действие одно и то же — не трогать.
 */
async function ensureCardConfig(call: RestCall, ref: SmartProcessRef): Promise<boolean> {
  const read = buildReadCardConfigCall(ref.entityTypeId)
  if (hasCardConfig(await call(read.method, read.params))) return false

  const set = buildSetCardConfigCall(ref.entityTypeId, ref.id)
  await call(set.method, set.params)
  return true
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

  // ⚠ Только «Опросу»: «Шаблон опроса» ни к какой сделке не относится — он про анкету,
  // а не про её прохождение.
  // ⚠ В try/catch, как и раскладка ниже. Первая редакция звала без обёртки, и тарифный отказ
  // (`UPDATE_DYNAMIC_TYPE_RESTRICTED` — задокументированный код `crm.type.update`) ронял ВСЮ
  // установку: идентификаторы не сохранялись, вкладка в карточке не регистрировалась, а строка
  // `logger.error` про ненастроенную связь, заведённая ровно под этот случай, не выполнялась
  // никогда. Собственный JSDoc обещал обратное. Нашли трое проверяющих независимо.
  let dealLinked = false
  try {
    dealLinked = await ensureDealRelation(call, survey.ref)
  }
  catch (error) {
    logger.warn({ reason: safeRefusal(error) }, 'связь «Опроса» со сделкой не настроена')
  }

  // ⚠ Раскладка карточки — удобство, и её неудача установку не роняет: без неё приложение
  // работает целиком, просто карточка выглядит хуже. Роняя установку из-за косметики,
  // мы поменяли бы местами главное и второстепенное.
  let cardConfigured = false
  try {
    cardConfigured = await ensureCardConfig(call, survey.ref)
  }
  catch (error) {
    logger.warn({ reason: safeRefusal(error) }, 'раскладка карточки «Опроса» не настроена')
  }

  return {
    template: template.ref,
    survey: survey.ref,
    createdTemplate: template.created,
    createdSurvey: survey.created,
    adoptedTemplate: template.adopted,
    adoptedSurvey: survey.adopted,
    addedFields: addedTemplate + addedSurvey,
    dealLinked,
    cardConfigured,
  }
}

/**
 * Зарегистрировать вкладку приложения в карточке сделки.
 *
 * ⚠ Отдельным вызовом, не в батче: `placement.bind` в батче отвечает
 * `ERROR_BATCH_METHOD_NOT_ALLOWED`.
 *
 * ⚠ Сначала `unbind`, потом `bind`, и это не перестраховка. Точка с одной регистрацией
 * на повторный `bind` отвечает `ERROR_PLACEMENT_MAX_COUNT`, то есть сменить АДРЕС обработчика
 * повторной регистрацией нельзя — портал продолжит открывать старый, и снаружи это выглядит
 * как «вкладка ведёт не туда» на свежем выкате. Снятие делает переустановку настоящим
 * способом починки: адрес всегда становится текущим. Панель ревью PR #18 указала, что иначе
 * ошибка в публичном адресе на первой установке неисправима штатными средствами.
 *
 * Отказ `unbind` игнорируется: на первой установке снимать нечего, и это норма.
 *
 * ⚠ Снимаем БЕЗ адреса обработчика. С адресом снялась бы регистрация только на него, а снять
 * надо ровно ту, адреса которой мы не знаем, — старую. Первая версия передавала сюда НОВЫЙ
 * адрес, то есть снимала вхолостую и оставляла портал на старом обработчике, отчитавшись
 * об успехе.
 *
 * Возвращает `false`, когда вкладку зарегистрировать не удалось по настоящей причине. Установку
 * это не роняет: без вкладки приложение работает, ссылку можно выпустить и роботом, а вот без
 * токенов не работает ничего.
 */
export async function ensureDealTabPlacement(call: RestCall, baseUrl: string): Promise<boolean> {
  const handlerUrl = buildDealTabHandlerUrl(baseUrl)
  if (handlerUrl === null) return false

  const bind = buildBindDealTabCall(handlerUrl)
  if (bind === null) return false

  const unbind = buildUnbindDealTabCall()
  try {
    await call(unbind.method, unbind.params)
  }
  catch {
    // Снимать было нечего — обычное дело на первой установке.
  }

  try {
    await call(bind.method, bind.params)
    return true
  }
  catch (error) {
    return isPlacementAlreadyBound(error) || isPlacementAlreadyBound((error as Error).message)
  }
}
