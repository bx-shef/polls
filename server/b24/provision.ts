import { safeRefusal } from '../domain/answers/portal-errors'
import { isRetryableRefusal } from '../domain/portals/portal-error'
import { logger } from '../utils/logger'
import {
  buildListFieldsCall,
  planCrmFieldLabels,
  planMissingCrmFields,
  readCrmFields,
  SCORE_FIELDS,
  SCORED_ENTITIES,
  type CrmEntity,
  type ExistingCrmField,
} from '../domain/portals/crm-fields'
import {
  DEAL_TAB_PLACEMENT,
  DEAL_TAB_TITLE,
  DEAL_TAB_TITLE_EN,
  TEMPLATE_TAB_PATH,
  TEMPLATE_TAB_TITLE,
  TEMPLATE_TAB_TITLE_EN,
  buildBindTabCall,
  buildDealTabHandlerUrl,
  buildTabHandlerUrl,
  buildUnbindTabCall,
  isPlacementAlreadyBound,
  templateTabPlacement,
} from '../domain/portals/placements'
import {
  SURVEY_RESULT_TITLE,
  buildListTypesCall,
  buildRegisterTypeCall,
  buildUpdateTypeCall,
  findRegisteredType,
  fullTypeCode,
  isOurFieldType,
  planTypeRegistration,
  readAppInfo,
} from '../domain/portals/userfield-type'
import {
  buildCardSections,
  buildCreateFieldCall,
  buildListSpFieldsCall,
  confirmsFieldOwnership,
  buildCreateSmartProcessCall,
  buildReadCardConfigCall,
  buildReadTypeCall,
  buildSetCardConfigCall,
  buildUpdateRelationsCall,
  hasCardConfig,
  hasTemplateExtras,
  findTypeByTitle,
  buildRenameTypeCall,
  buildTemplateFeaturesCall,
  planFieldOwnership,
  readTypeTitle,
  LEGACY_SURVEY_SP_TITLES,
  LEGACY_TEMPLATE_SP_TITLES,
  OWNERSHIP_REVISION,
  type SmartProcessKind,
  planDealRelation,
  planResultFieldInCard,
  readTypeRelations,
  planMissingFields,
  readCreatedRef,
  readFields,
  readNextOffset,
  readTypes,
  SURVEY_FIELDS,
  SURVEY_RESULT_FIELD,
  SURVEY_SP_TITLE,
  SURVEY_SP_TITLES,
  TEMPLATE_FIELDS,
  TEMPLATE_SP_TITLE,
  TEMPLATE_SP_TITLES,
  buildFieldName,
  normalizeFieldName,
  PROVISION_REVISION,
  RESULT_FIELD_REVISION,
  type ExistingField,
  type PortalCall,
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
 * ⚠ Вызывающий обязан обернуть `call` в `withDeadline`. Холодная установка — это 41
 * последовательный вызов под троттлингом SDK (число и порядок держит тест «холодная установка:
 * ровно 41 вызов портала» в `tests/unit/provision-outcome.test.ts`); без общего предела одна медленная сеть
 * держит HTTP-запрос установки до таймаута прокси. Предел на один вызов есть в клиенте,
 * но он не ограничивает цепочку целиком.
 */

/** Минимальный вызов портала. Реализация — SDK-клиент, привязанный к порталу. */
export type RestCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * Пакетный вызов: несколько методов за одно обращение к порталу.
 *
 * ⚠ Возвращает данные ТОЛЬКО УСПЕШНЫХ команд, ключ к ключу со входом. Отсутствие ключа —
 * это «команда не отработала», и молчаливый пропуск здесь намеренный: пакет заведён под
 * ЧТЕНИЕ, где частичный ответ осмыслен (шапка анкеты без контакта лучше, чем нет анкеты).
 * Под запись так брать нельзя: там «половина применилась» — это не результат, а беда,
 * и вызывающий обязан сверять состав ключей сам.
 *
 * ⚠ Ошибка отдельной команды НЕ бросается, ошибка всего пакета — бросается, как и у
 * одиночного вызова. Разница ровно та, что портал провёл между `result` и `result_error`
 * (проверено на живом портале 23.09: с `halt: 0` упавшая команда не мешает остальным).
 */
export type RestBatch = (calls: Record<string, PortalCall>) => Promise<Record<string, unknown>>

/**
 * Портал, с которым можно говорить: по одному методу и пакетом.
 *
 * ⚠ Одним объектом, а не двумя независимыми функциями, и это не косметика: за обеими
 * стоит ОДИН клиент SDK, то есть один `RestrictionManager`. Собери их порознь — получишь
 * два троттлинга на один портал, каждый со своей картиной лимитов, и оба неверные.
 */
export interface PortalCaller {
  call: RestCall
  batch: RestBatch
}

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

/**
 * Что портал помнит о своём обустройстве: идентификаторы и ревизия.
 *
 * ⚠ Ревизия лежит ТАМ ЖЕ, где идентификаторы, а не у нас в базе, и это следование инварианту
 * «источник истины — портал». Своя колонка была бы дешевле в чтении — фильтр в SQL вместо
 * вызова на портал, — но завела бы второй источник правды о том, как настроен чужой портал,
 * ровно рядом с первым. Цена честного варианта: один `app.option.get` на портал в час.
 */
/** Исход шага с полем виджета. Разбор — у `ProvisionResult.resultField`. */
export type ResultFieldOutcome = 'ok' | 'deferred' | 'failed'

/** Что обустройству нужно сверх сохранённых идентификаторов. */
export interface ProvisionOptions {
  /** Адрес страницы виджета. `null` — хост не `https`, и поле честно не заводится. */
  resultHandlerUrl?: string | null
  /** Ревизия, до которой портал был обустроен раньше. От неё зависят разовые правки. */
  previousRevision?: number
}

/** Which of our smart processes were once found by title instead of being created or remembered. */
export type AdoptedKinds = Partial<Record<SmartProcessKind, true>>

export interface StoredProvision extends Partial<SmartProcessRefs> {
  /** `0` — портал обустраивался до появления ревизий либо не обустраивался вовсе. */
  revision: number
  /**
   * Смарт-процессы, которые мы когда-то нашли по названию («усыновили»), а не создали.
   *
   * ⚠ Хранится ВМЕСТЕ с идентификаторами и переживает прогоны. Без него защита «чужой смарт-
   * процесс не переименовываем» держалась ровно один прогон: идентификатор усыновлённого
   * сохранялся, и уже следующий прогон — донастройка после `installFinish` через час — считал
   * его своим и переименовывал, выключая клиенту роботов. Нашёл `/code-review` во втором круге
   * PR #87, воспроизведя двумя прогонами.
   */
  adopted: AdoptedKinds
}

export interface ProvisionResult extends SmartProcessRefs {
  createdTemplate: boolean
  createdSurvey: boolean
  /**
   * Смарт-процесс не создан нами, а найден на портале по заголовку — этим прогоном или одним
   * из прошлых (признак хранится вместе с идентификаторами, `StoredProvision.adopted`).
   *
   * Вызывающий обязан это залогировать и сохранить: заголовки «Опрос» и «Шаблон опроса» —
   * обычные слова, и совпасть может чужой смарт-процесс, заведённый клиентом руками. Отличить
   * его от нашего, потерявшего идентификатор, нечем — а дальше мы допишем в него свои поля.
   * Переименовывать и перенастраивать усыновлённый мы не станем никогда (`settleSmartProcesses`).
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
  /**
   * Записали ли мы раскладку карточки «Опроса» — с нуля или поставив виджет в свой раздел.
   * `false` — там уже всё стояло, раскладка чужая либо не вышло.
   */
  cardConfigured: boolean
  /**
   * Что с полем своего типа «Результат опроса».
   *
   * ⚠ `deferred` — установка ещё не завершена (`installFinish` не вызван), и портал поле
   * своего типа пока не примет. Вызывающий обязан НЕ отмечать ревизию: тогда фоновая донастройка
   * доделает шаг после установки. Отметив её, мы не вернулись бы к порталу никогда.
   *
   * ⚠ `failed` установку не роняет: данные на месте, в карточке остаются JSON-поля. Но вызывающий
   * обязан это залогировать — иначе «виджета нет» узнаётся от клиента, а не из журнала.
   */
  resultField: ResultFieldOutcome
  /**
   * Сколько полей заведено на сущностях CRM клиента (сделка, контакт).
   *
   * ⚠ `null` означает, что завести их НЕ ВЫШЛО, и это не то же самое, что ноль. Ноль —
   * «всё уже было на месте», штатный исход повторной установки. `null` — портал отказал,
   * чаще всего по правам, и тогда обещанное клиенту «отфильтровать сделки с плохой оценкой»
   * не работает, хотя приложение установлено и всё остальное делает. Вызывающий обязан
   * это залогировать: ровно такой исход — «установлено, но главного не делает» — уже был
   * месяц невидимым у связи со сделкой.
   */
  crmFields: number | null
  /**
   * Разовая миграция ревизии 4 — метка владельца и закрытие полей. `null` — не требовалась:
   * портал уже был на ревизии 4 или выше.
   *
   * ⚠ `fieldsLocked: false` или `settled: false` — миграция не доделана. Вызывающий обязан тогда
   * НЕ отмечать ревизию: донастройка вернётся к порталу через час и попробует снова. Главное
   * в этой миграции — закрыть поля, и «не закрыли» не должно выглядеть как «нечего было закрывать».
   */
  ownership: OwnershipOutcome | null
}

/** Итог разовой миграции ревизии 4. */
export interface OwnershipOutcome {
  /** Сколько изменяющих вызовов сделано. Ноль — всё уже было на месте. */
  changes: number
  /** Все наши поля обоих смарт-процессов закрыты — и портал это подтвердил ответом. */
  fieldsLocked: boolean
  /**
   * Остальное доделано: названия, возможности «Шаблона», подписи на сделке и контакте.
   *
   * `false` — был отказ, который стоит повторить: предел запросов, сбой связи (`isRetryableRefusal`).
   * Отказ, который повтором не лечится, — тариф (`UPDATE_DYNAMIC_TYPE_RESTRICTED`), права, проверка
   * значения, — сюда не считается: иначе такой портал переобустраивался бы каждый час вечно.
   */
  settled: boolean
}

/** Смарт-процесс после поиска: откуда он взялся, решает, что с ним можно делать дальше. */
interface EnsuredSmartProcess {
  ref: SmartProcessRef
  /** Создан этим запуском — уже с нынешним названием, возможностями и закрытыми полями. */
  created: boolean
  /** Найден по названию, а не по сохранённому идентификатору: может оказаться чужим. */
  adopted: boolean
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
export async function readStoredRefs(call: RestCall): Promise<StoredProvision> {
  const response = await call('app.option.get', { option: SP_REFS_OPTION }) as { result?: unknown } | null
  const raw = response?.result
  if (typeof raw !== 'string' || raw === '') return { revision: 0, adopted: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<SmartProcessRefs> & { revision?: unknown, adopted?: Record<string, unknown> }
    const revision = Number(parsed.revision)
    return {
      template: validRef(parsed.template),
      survey: validRef(parsed.survey),
      // ⚠ Ноль, а не текущая ревизия: портал, обустроенный ДО появления отметки, обязан
      // выглядеть устаревшим. Подставив текущую, мы объявили бы настроенным всё, что уже
      // установлено, — то есть закрыли бы ровно ту дыру, ради которой отметка и заводится.
      revision: Number.isInteger(revision) && revision > 0 ? revision : 0,
      adopted: {
        ...(parsed.adopted?.template === true ? { template: true } : {}),
        ...(parsed.adopted?.survey === true ? { survey: true } : {}),
      },
    }
  }
  catch {
    // Испорченное значение не должно мешать установке: не прочитали — значит найдём
    // смарт-процессы по заголовку и перезапишем.
    return { revision: 0, adopted: {} }
  }
}

/** The stored option: refs, and the revision and adoption marks when there are any. */
function storedOption(refs: SmartProcessRefs, revision: number, adopted: AdoptedKinds): string {
  return JSON.stringify({
    ...refs,
    ...(revision > 0 ? { revision } : {}),
    ...(adopted.template === true || adopted.survey === true ? { adopted } : {}),
  })
}

/**
 * Записать идентификаторы на портал. Требует прав администратора.
 *
 * ⚠ Вместе с ПРЕЖНЕЙ ревизией, если она была. Идентификаторы и ревизия лежат в одной опции,
 * и запись без ревизии её стирала: портал ревизии 3, на котором не закрылись поля, следующим
 * прогоном читался как ревизия 0 — и разовая правка раскладки срабатывала снова, возвращая
 * виджет в карточку клиента, который его убрал. Нашёл `/code-review` в PR #87.
 *
 * ⚠ И вместе с признаком усыновления — по той же причине: он обязан пережить прогон
 * (`StoredProvision.adopted`).
 */
export async function storeRefs(
  call: RestCall,
  refs: SmartProcessRefs,
  // ⚠ Обязательны, без умолчаний: вызов без них молча стёр бы ревизию и признак усыновления —
  // ровно те два дефекта, что чинили в панели PR #87. Нашёл `/review` во втором круге.
  keep: { revision: number, adopted: AdoptedKinds },
): Promise<void> {
  await call('app.option.set', { options: { [SP_REFS_OPTION]: storedOption(refs, keep.revision, keep.adopted) } })
}

/**
 * Отметить, какой ревизией обустроен портал.
 *
 * ⚠ Пишется ПОСЛЕДНИМ шагом обустройства и отдельным вызовом, а не вместе с идентификаторами.
 * Идентификаторы нужны следующим шагам той же цепочки — без них не собрать имена полей, — а
 * отметка означает «всё, что обещает эта ревизия, сделано». Записав её вместе с ними, мы бы
 * объявили портал настроенным до того, как зарегистрировали вкладки.
 *
 * ⚠ Мягкие отказы отметку НЕ отменяют, и это осознанный размен. Связь со сделкой не настроится
 * на тарифе, который запрещает править смарт-процессы; вкладка не встанет, если публичный адрес
 * не задан. Считая такой портал вечно устаревшим, мы ходили бы к нему с десятками вызовов
 * каждый час — без единого шанса что-то изменить. Эти отказы и без того пишутся в журнал
 * громко, ошибкой.
 *
 * `revision` — та, до которой дошёл этот прогон (`reachedRevision`); меньше текущей, когда
 * доделано всё, кроме разовой миграции. Параметры обязательны по той же причине, что у `storeRefs`.
 */
export async function storeProvisionRevision(
  call: RestCall,
  refs: SmartProcessRefs,
  revision: number,
  adopted: AdoptedKinds,
): Promise<void> {
  await call('app.option.set', { options: { [SP_REFS_OPTION]: storedOption(refs, revision, adopted) } })
}

/**
 * The revision this run brought the portal to.
 *
 * ⚠ Здесь, а не у вызывающего: какие разовые шаги прошли, знает обустройство. Ревизия — наименьшая
 * из достигнутых: поле виджета отложено (`deferred`) — портал остаётся на прежней, потому что
 * установка не завершена и донастройка обязана вернуться; не доделана только миграция 4 — портал
 * на ревизии до неё, ведь всё прежнее на месте. Иначе портал ревизии 2 оставался бы на ней,
 * и разовая правка раскладки ревизии 3 повторялась бы каждый час, возвращая виджет клиенту,
 * который его убрал. Первая редакция считала это у вызывающего особым случаем; `/review`
 * во втором круге PR #87 заметил, что следующая миграция добавила бы туда второй — поэтому здесь.
 */
export function reachedRevision(previous: number, result: Pick<ProvisionResult, 'resultField' | 'ownership'>): number {
  if (result.resultField === 'deferred') return previous
  const ownership = result.ownership
  const unfinished = ownership !== null && (!ownership.fieldsLocked || !ownership.settled)
  return unfinished ? Math.max(previous, OWNERSHIP_REVISION - 1) : PROVISION_REVISION
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

/** All fields of a smart process, every page, with id, name, type and label. */
async function listAllFields(call: RestCall, spTypeId: number): Promise<ExistingField[]> {
  const fields: ExistingField[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const list = buildListSpFieldsCall(spTypeId, start)
    const response = await call(list.method, list.params)
    fields.push(...readFields(response))
    start = readNextOffset(response)
  }
  return fields
}

/**
 * Завести на сделке и контакте клиента поля «оценка» и «дата опроса».
 *
 * ⚠ ДЕЛАЕТСЯ ПРИ УСТАНОВКЕ, а не по отдельной настройке, и это решение стоит назвать.
 * Альтернатива — заводить поля по галочке в настройках — откладывала бы главное обещание
 * продукта до экрана настроек, которого ещё нет, и оставляла бы клиента с приложением,
 * которое «почти работает». Цена обратного выбора записана в шапке `crm-fields.ts`: два
 * лишних поля в карточке каждой сделки, которые при удалении приложения остаются.
 *
 * ⚠ Одно упавшее поле НЕ обрывает остальные — тот же приём и та же причина, что у полей
 * смарт-процесса: у соседа цикл падал на первой ошибке, и поля ниже по списку не создавались
 * никогда.
 *
 * Возвращает число созданных. Ноль — всё уже было: повторная установка ничего не портит.
 *
 * `seen` получает поля каждой сущности такими, какими они были ДО создания недостающих, —
 * даже если создание потом упало. Их разбирает миграция подписей ревизии 4, и второй раз
 * листать те же списки на критическом пути установки незачем (панель ревью PR #87).
 */
async function ensureCrmScoreFields(call: RestCall, seen: Map<CrmEntity, readonly ExistingCrmField[]>): Promise<number> {
  let added = 0
  const failures: string[] = []

  for (const entity of SCORED_ENTITIES) {
    const existing = await listAllCrmFields(call, entity)
    seen.set(entity, existing)
    for (const plan of planMissingCrmFields(entity, SCORE_FIELDS, existing.map(field => field.name))) {
      try {
        await call(plan.method, plan.params)
        added++
      }
      catch (error) {
        const code = ((plan.params.fields as { FIELD_NAME?: unknown }).FIELD_NAME)
        failures.push(`${entity.title}/${String(code)}: ${safeRefusal(error)}`)
      }
    }
  }

  if (failures.length > 0) throw new Error(failures.join('; '))
  return added
}

/** The entity's user fields with id and label, every page. */
async function listAllCrmFields(call: RestCall, entity: CrmEntity): Promise<ExistingCrmField[]> {
  const fields: ExistingCrmField[] = []
  let start: number | null = 0

  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const list = buildListFieldsCall(entity, start)
    const response = await call(list.method, list.params)
    fields.push(...readCrmFields(response))
    start = readNextOffset(response)
  }

  return fields
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
  titles: readonly string[],
  kind: SmartProcessKind,
  // Усыновлён одним из прошлых прогонов: сохранённый идентификатор ещё не значит «наш».
  adoptedBefore: boolean,
): Promise<EnsuredSmartProcess> {
  if (known !== undefined) return { ref: known, created: false, adopted: adoptedBefore }

  const found = findTypeByTitle(types, titles)
  if (found !== null) return { ref: found, created: false, adopted: true }

  // Создаём под нынешним названием — первым в списке; прежние нужны только поиску.
  const title = titles[0]!
  const create = buildCreateSmartProcessCall(title, kind)
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
 *
 * Возвращает, сколько создано, и поля такими, какими они были ДО создания: их разбирает
 * миграция ревизии 4, и второй раз листать тот же список незачем.
 */
async function ensureFields(
  call: RestCall,
  ref: SmartProcessRef,
  fields: readonly SmartProcessField[],
): Promise<{ added: number, existing: ExistingField[] }> {
  const existing = await listAllFields(call, ref.id)
  const planned = planMissingFields(ref.id, fields, existing.map(field => field.name))
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
  return { added, existing }
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
    // и чинится по-другому: среди связей есть запись, формы которой мы не узнали, и мы
    // намеренно не трогаем настройки, чтобы её не стереть (`readTypeRelations`).
    //
    // ⚠ `typeId` в строке обязателен: установщик обслуживает много порталов, и строка без него
    // не привязывается ни к одному — соседний `logger.error` с `domain` связывался бы с ней
    // только по времени. Идентификатор ТИПА персональными данными не является, запрет
    // `CLAUDE.md` его не касается. Нашёл `/code-review` в PR #51.
    logger.warn({ typeId: ref.id }, 'связь со сделкой не тронута: настройки связей не разобраны')
    return false
  }

  const planned = planDealRelation(current)
  if (planned === null) return true

  const update = buildUpdateRelationsCall(ref, planned)
  const relations = readTypeRelations(await call(update.method, update.params))

  // ⚠ Проверяем ОТВЕТ, а не факт отсутствия исключения. Двухсотый ответ без связи в списке
  // означал бы, что портал принял запрос и ничего не сделал, — и мы отчитались бы об успехе
  // ровно там, где до этого месяц молчали.
  const written = relations !== null && planDealRelation(relations) === null

  // ⚠ И этот отказ тоже обязан быть слышен. Он остался молчащим, когда соседний научился
  // говорить, — то есть владельца отправляли бы чинить тариф («чаще всего это тариф»
  // в `register.ts`) там, где запись на самом деле прошла, а разобрать не вышло эхо.
  // Нашёл `/code-review` в PR #51.
  if (!written) {
    logger.warn(
      { typeId: ref.id, echo: relations === null ? 'не разобрано' : 'связи нет в ответе' },
      'связь со сделкой записана, но портал не подтвердил',
    )
  }

  return written
}

/**
 * Разложить карточку «Опроса» так, чтобы в ней было видно главное.
 *
 * ⚠ Целиком — только на ПУСТОМ месте. `crm.item.details.configuration.set` перезаписывает
 * раскладку целиком и сразу для всех пользователей — это настройка клиента, а не наша.
 * Разложивший карточку под себя получал бы нашу при каждой переустановке; такого мы уже
 * натворили бы со связями, если бы не сливали их. Поэтому сначала читаем, и ставим, только
 * если пусто.
 *
 * ⚠ Если раскладка уже стоит — единственная правка, которую мы себе позволяем: поставить
 * виджет в СВОЙ раздел (`planResultFieldInCard`, там же — почему это не посягательство
 * на чужую раскладку). Иначе порталы, установленные раньше, не увидели бы виджета никогда.
 * И только при переходе на ревизию с виджетом (`upgradeToResultField`): повторяясь при каждом
 * обустройстве, правка возвращала бы виджет клиенту, который убрал его сам.
 *
 * `resultField` — заведено ли поле виджета. Без него раскладка остаётся при JSON: ставить
 * в карточку поле, которого на элементе нет, значит показать пустое место вместо ответов.
 *
 * Возвращает, записали ли мы раскладку. `false` здесь — и «не поставили», и «там уже своя»:
 * различать их незачем, действие одно и то же — не трогать.
 */
async function ensureCardConfig(
  call: RestCall,
  ref: SmartProcessRef,
  resultField: boolean,
  upgradeToResultField: boolean,
): Promise<boolean> {
  const read = buildReadCardConfigCall(ref.entityTypeId)
  const current = await call(read.method, read.params)

  const sections = !hasCardConfig(current)
    ? buildCardSections(ref.id, resultField)
    : resultField && upgradeToResultField ? planResultFieldInCard(current, ref.id) : null
  if (sections === null) return false

  const set = buildSetCardConfigCall(ref.entityTypeId, sections)
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
  known: Partial<SmartProcessRefs> & { adopted?: AdoptedKinds } = {},
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  // Список запрашиваем, только если хоть один идентификатор неизвестен, — и один раз на оба.
  const types = known.template !== undefined && known.survey !== undefined ? [] : await listAllTypes(call)

  const template = await ensureSmartProcess(call, known.template, types, TEMPLATE_SP_TITLES, 'template', known.adopted?.template === true)
  const survey = await ensureSmartProcess(call, known.survey, types, SURVEY_SP_TITLES, 'survey', known.adopted?.survey === true)

  const templateFields = await ensureFields(call, template.ref, TEMPLATE_FIELDS)
  const surveyFields = await ensureFields(call, survey.ref, SURVEY_FIELDS)

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

  // ⚠ Поле виджета — ДО раскладки карточки, и порядок здесь не случайный. Раскладка
  // ставит в карточку имена полей; поставив туда поле, которого ещё нет, мы полагались бы
  // на то, как портал поведёт себя с несуществующим именем, — а это нигде не описано.
  // Неудача установку не роняет: данные на месте, раскладка просто остаётся при JSON.
  let resultField: ResultFieldOutcome = 'failed'
  const resultHandlerUrl = options.resultHandlerUrl ?? null
  if (resultHandlerUrl !== null) {
    try {
      resultField = await ensureSurveyResultField(call, resultHandlerUrl, survey.ref, surveyFields.existing)
    }
    catch (error) {
      logger.warn({ reason: safeRefusal(error) }, 'поле «Результат опроса» не заведено')
    }
  }

  // ⚠ Раскладка карточки — удобство, и её неудача установку не роняет: без неё приложение
  // работает целиком, просто карточка выглядит хуже. Роняя установку из-за косметики,
  // мы поменяли бы местами главное и второстепенное.
  let cardConfigured = false
  try {
    cardConfigured = await ensureCardConfig(
      call,
      survey.ref,
      resultField === 'ok',
      (options.previousRevision ?? 0) < RESULT_FIELD_REVISION,
    )
  }
  catch (error) {
    logger.warn({ reason: safeRefusal(error) }, 'раскладка карточки «Опроса» не настроена')
  }

  // ⚠ Поля на ЧУЖИХ сущностях — сделке и контакте клиента. Без них балл виден только
  // в карточке «Опроса», а он дочерняя сущность: ни фильтр в списке сделок, ни робот
  // на стадии до него не дотягиваются (issue #23). Неудача установку НЕ роняет — приложение
  // без этих полей работает целиком, просто обещание «отфильтровать сделки с плохой оценкой»
  // остаётся невыполненным, и это видно в журнале.
  let crmFields: number | null = null
  const crmSeen = new Map<CrmEntity, readonly ExistingCrmField[]>()
  try {
    crmFields = await ensureCrmScoreFields(call, crmSeen)
  }
  catch (error) {
    logger.warn({ reason: safeRefusal(error) }, 'поля оценки на сделке и контакте не заведены')
  }

  // ⚠ ПОСЛЕ полей и поля виджета: метка и закрытие ложатся на поля, которые были до этого
  // запуска, а созданное им миграции не нужно — сборщик создания ставит всё сразу.
  // Разово: при переходе на ревизию 4, см. `OWNERSHIP_REVISION`. На свежей установке это ноль
  // вызовов: списки уже прочитаны шагами выше, а править в них нечего.
  let ownership: OwnershipOutcome | null = null
  if ((options.previousRevision ?? 0) < OWNERSHIP_REVISION) {
    ownership = await ensureOwnership(call, {
      template,
      survey,
      types,
      fields: { template: templateFields.existing, survey: surveyFields.existing },
      crm: crmSeen,
    })
  }

  return {
    template: template.ref,
    survey: survey.ref,
    createdTemplate: template.created,
    createdSurvey: survey.created,
    adoptedTemplate: template.adopted,
    adoptedSurvey: survey.adopted,
    addedFields: templateFields.added + surveyFields.added,
    dealLinked,
    cardConfigured,
    resultField,
    crmFields,
    ownership,
  }
}

/** What the one-off revision 4 migration works from: all of it is already read by the steps before it. */
interface OwnershipInput {
  template: EnsuredSmartProcess
  survey: EnsuredSmartProcess
  /** The portal's smart processes, if the search listed them. Empty — not listed. */
  types: readonly Record<string, unknown>[]
  /** Our smart processes' fields as they were before this run created the missing ones. */
  fields: { template: readonly ExistingField[], survey: readonly ExistingField[] }
  /** Deal and contact fields as `ensureCrmScoreFields` found them. A missing entity is listed anew. */
  crm: ReadonlyMap<CrmEntity, readonly ExistingCrmField[]>
}

/**
 * Разовая миграция портала, обустроенного до ревизии 4: метка владельца `[sh]` в названиях
 * и подписях, наши поля закрыты от правки, у «Шаблона» выключены «Клиент» и роботы
 * (решения владельца 28.09, issue #84, пункты 12, 16, 19 и 22).
 *
 * ⚠ Каждый изменяющий вызов — в своём `try`: отказ одного не мешает остальным и установку
 * не роняет. Тариф может запрещать правку смарт-процессов (`UPDATE_DYNAMIC_TYPE_RESTRICTED`),
 * а поля при этом закрыть всё равно нужно — это главное, ради чего миграция и заведена:
 * открытые поля позволяли подделать ответ клиента и опубликовать шаблон в обход проверок.
 *
 * Повторный запуск на готовом портале — ноль изменяющих вызовов; на свежей установке — ноль
 * вызовов вовсе: всё, что нужно, уже прочитано шагами до неё.
 */
async function ensureOwnership(call: RestCall, input: OwnershipInput): Promise<OwnershipOutcome> {
  const outcome: OwnershipOutcome = { changes: 0, fieldsLocked: true, settled: true }

  await settleSmartProcesses(call, input, outcome)
  await lockFields(call, 'поля «Шаблона опроса»', input.template.ref.id, TEMPLATE_FIELDS, input.fields.template, outcome)
  await lockFields(
    call,
    'поля «Результата опросов»',
    input.survey.ref.id,
    [...SURVEY_FIELDS, { postfix: SURVEY_RESULT_FIELD, label: SURVEY_RESULT_TITLE }],
    input.fields.survey,
    outcome,
  )
  await labelCrmFields(call, input.crm, outcome)

  return outcome
}

/**
 * Переименовать наши смарт-процессы и выключить у «Шаблона» то, что ему не нужно.
 *
 * ⚠ ТОЛЬКО ИЗВЕСТНЫЕ ПО СОХРАНЁННОМУ ИДЕНТИФИКАТОРУ. Найденный по названию («усыновлённый»)
 * может оказаться чужим: прежние голые названия ищутся всегда, и на свежей установке у клиента
 * может найтись свой «Шаблон опроса». Переименовав его и выключив ему роботов и «Клиента», мы
 * испортили бы чужие настройки — до ревизии 4 усыновлённому только дописывались поля. Наш,
 * потерявший идентификатор при переустановке, останется со старым названием: это видно
 * в журнале (`adopted`) и правится руками. Нашли `/review` и `/code-review` в PR #87.
 * Признак усыновления хранится вместе с идентификаторами (`StoredProvision.adopted`): иначе
 * уже следующий прогон считал бы такой смарт-процесс известным и переименовал бы его.
 * Созданный этим запуском уже носит нынешнее название и нужные возможности.
 *
 * Смарт-процесс, которого нет в списке портала, не трогаем: «переименовать» его было бы
 * вслепую — по идентификатору, который мог уйти в корзину.
 *
 * ⚠ Переименовываем только из НАШЕГО прежнего названия. Смарт-процесс, который администратор
 * назвал по-своему, остаётся с его названием: иначе повтор незавершённой миграции спорил бы
 * с ним каждый час — ровно то, от чего миграция и сделана разовой. Нашёл `/review` во втором круге.
 */
async function settleSmartProcesses(call: RestCall, input: OwnershipInput, outcome: OwnershipOutcome): Promise<void> {
  const ours = [
    { sp: input.template, title: TEMPLATE_SP_TITLE, legacy: LEGACY_TEMPLATE_SP_TITLES, template: true },
    { sp: input.survey, title: SURVEY_SP_TITLE, legacy: LEGACY_SURVEY_SP_TITLES, template: false },
  ].filter(one => !one.sp.created && !one.sp.adopted)
  if (ours.length === 0) return

  let types = input.types
  if (types.length === 0) {
    try {
      types = await listAllTypes(call)
    }
    catch (error) {
      refuse(outcome, 'список смарт-процессов', error)
      return
    }
  }

  for (const { sp, title, legacy, template } of ours) {
    const current = readTypeTitle(types, sp.ref.id)
    if (current === null) continue
    if (legacy.includes(current.trim())) await updateType(call, buildRenameTypeCall(sp.ref, title), outcome)
    // ⚠ Не «включено ли», а «не выключено ли наверняка»: при флаге непонятной формы выключение
    // шлётся всё равно — оно идемпотентно, а промолчав, мы оставили бы роботов включёнными
    // навсегда и молча. Нашёл `/code-review` во втором круге PR #87.
    if (template && hasTemplateExtras(types, sp.ref.id) !== false) {
      await updateType(call, buildTemplateFeaturesCall(sp.ref), outcome)
    }
  }
}

/**
 * Один изменяющий вызов `crm.type.update`; отказ разбирается по коду (`refuse`).
 *
 * ⚠ Каждый — в своём `try`. Прежде первый упавший вызов обрывал остальные, а любой отказ отпускал
 * ревизию: одно случайное «слишком много запросов» навсегда отменяло переименование обоих
 * смарт-процессов и выключение роботов у «Шаблона». Нашли `/review` и `/code-review` в PR #87.
 */
async function updateType(call: RestCall, update: PortalCall, outcome: OwnershipOutcome): Promise<void> {
  try {
    await call(update.method, update.params)
    outcome.changes++
  }
  catch (error) {
    refuse(outcome, 'названия и возможности', error)
  }
}

/**
 * Закрыть наши поля одного смарт-процесса и поставить им подпись с меткой.
 *
 * ⚠ Каждое поле — в своём `try`: одно упавшее не обрывает остальные. Прежде цикл обрывался
 * на первом отказе, и поля за ним — `STATE`, `SCHEMA`, правкой которых владелец и публиковал
 * в обход проверок, — оставались открытыми. Тот же приём и та же причина, что у `ensureFields`.
 * Нашли `/review` и `/code-review` в PR #87.
 *
 * ⚠ Закрытым поле считается, только когда портал ПОДТВЕРДИЛ это ответом
 * (`confirmsFieldOwnership`), а поле без идентификатора настроек — не закрыто. Иначе
 * «закрыть не смогли» выглядело бы как «закрывать было нечего», и ревизия отметилась бы
 * с открытым полем навсегда. Нашли безопасность и `/review` в панели PR #87.
 */
async function lockFields(
  call: RestCall,
  step: string,
  spTypeId: number,
  ours: readonly { postfix: string, label: string }[],
  existing: readonly ExistingField[],
  outcome: OwnershipOutcome,
): Promise<void> {
  const plan = planFieldOwnership(spTypeId, ours, existing)
  const unconfirmed: unknown[] = []

  for (const update of plan.calls) {
    try {
      const response = await call(update.method, update.params)
      outcome.changes++
      if (!confirmsFieldOwnership(response, update)) unconfirmed.push(update.params.id)
    }
    catch (error) {
      unconfirmed.push(update.params.id)
      logger.warn({ step, reason: safeRefusal(error) }, 'метка владельца: поле не закрыто')
    }
  }

  if (unconfirmed.length > 0 || plan.unaddressable.length > 0) {
    outcome.fieldsLocked = false
    // Идентификаторы настроек и постфиксы полей — наши, данных клиента в них нет.
    logger.warn({ step, unconfirmed, unaddressable: plan.unaddressable }, 'метка владельца: не все наши поля закрыты')
  }
}

/**
 * Поставить метку в подписи наших полей на сделке и контакте клиента.
 *
 * Подписи — не безопасность, но и они должны доехать: отказ оставляет миграцию незавершённой,
 * и донастройка вернётся. Каждый вызов — в своём `try`.
 */
async function labelCrmFields(
  call: RestCall,
  seen: ReadonlyMap<CrmEntity, readonly ExistingCrmField[]>,
  outcome: OwnershipOutcome,
): Promise<void> {
  const step = 'подписи полей сделки и контакта'
  for (const entity of SCORED_ENTITIES) {
    let existing = seen.get(entity)
    if (existing === undefined) {
      try {
        existing = await listAllCrmFields(call, entity)
      }
      catch (error) {
        refuse(outcome, step, error)
        continue
      }
    }

    for (const update of planCrmFieldLabels(entity, SCORE_FIELDS, existing)) {
      try {
        await call(update.method, update.params)
        outcome.changes++
      }
      catch (error) {
        refuse(outcome, step, error)
      }
    }
  }
}

/**
 * Sort a refusal of a cosmetic step: worth a retry — the migration stays unfinished; not — let it go.
 *
 * ⚠ Держим миграцию незавершённой ТОЛЬКО на отказе, который лечится повтором (`isRetryableRefusal`).
 * Первая редакция держала её на любом нетарифном отказе, и стабильное «доступ запрещён» на подписи
 * контакта оставляло бы портал на ревизии 3 навсегда: каждый час полное переобустройство без
 * единого шанса что-то изменить. Нашёл `/review` во втором круге PR #87. Слова портала в журнал
 * не попадают (`safeRefusal`).
 */
function refuse(outcome: OwnershipOutcome, step: string, error: unknown): void {
  if (isRetryableRefusal(error)) {
    outcome.settled = false
    logger.warn({ step, reason: safeRefusal(error) }, 'метка владельца: шаг не удался, донастройка вернётся')
    return
  }
  logger.warn({ step, reason: safeRefusal(error) }, 'метка владельца: портал отказал, повтор не поможет')
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
  return ensureTabPlacement(call, {
    placement: DEAL_TAB_PLACEMENT,
    handlerUrl: buildDealTabHandlerUrl(baseUrl),
    title: DEAL_TAB_TITLE,
    titleEn: DEAL_TAB_TITLE_EN,
  })
}

/**
 * Зарегистрировать вкладку конструктора в карточке «Шаблона опроса».
 *
 * ⚠ `entityTypeId`, а не `id` смарт-процесса: разбор в `templateTabPlacement`. Ошибка здесь
 * не молчит — портал отвечает `ERROR_PLACEMENT_NOT_FOUND`, — но и не чинится сама.
 *
 * Отказ установку не роняет, как и у вкладки сделки: без конструктора приложение работает,
 * анкеты приезжают переносом из старого решения.
 */
export async function ensureTemplateTabPlacement(
  call: RestCall,
  baseUrl: string,
  entityTypeId: number,
): Promise<boolean> {
  return ensureTabPlacement(call, {
    placement: templateTabPlacement(entityTypeId),
    handlerUrl: buildTabHandlerUrl(baseUrl, TEMPLATE_TAB_PATH),
    title: TEMPLATE_TAB_TITLE,
    titleEn: TEMPLATE_TAB_TITLE_EN,
  })
}

/** Общий порядок регистрации вкладки: снять старую, поставить новую. Разбор — в шапке выше. */
async function ensureTabPlacement(
  call: RestCall,
  tab: { placement: string, handlerUrl: string | null, title: string, titleEn: string },
): Promise<boolean> {
  if (tab.handlerUrl === null) return false

  const bind = buildBindTabCall(tab.placement, tab.handlerUrl, tab.title, tab.titleEn)
  if (bind === null) return false

  const unbind = buildUnbindTabCall(tab.placement)
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

/**
 * Завести на «Опросе» поле своего типа — с нашим виджетом над простынёй JSON.
 *
 * ⚠ ПОРЯДОК ОБЯЗАТЕЛЕН: сведения о приложении → регистрация типа → поле.
 * - `app.info` ПЕРВЫМ: до `installFinish()` поле своего типа портал не примет, а мастер
 *   установки обустраивает портал как раз до него. Тогда шаг откладывается целиком (`deferred`)
 *   — и тип не регистрируем тоже: незачем проверять на живом портале, что он скажет на это.
 * - Тип регистрируется, если его нет, и ПРАВИТСЯ, если адрес обработчика сменился
 *   (`planTypeRegistration`). Снимать и регистрировать заново нельзя: на типе висят поля
 *   в карточках клиента, и что с ними делает удаление типа, документация не говорит.
 * - Поле создаётся по ПОЛНОМУ коду `rest_<ID приложения>_<код>` (`fullTypeCode`). Поле с нашим
 *   именем, но чужого типа, не трогаем и виджет не ставим (`isOurFieldType`).
 *
 * ⚠ Отдельными вызовами, не батчем: `userfieldtype.add` и `.update` отвечают в батче
 * `ERROR_BATCH_METHOD_NOT_ALLOWED`.
 *
 * ⚠ Отказ портала БРОСАЕТСЯ, а не превращается в `failed` молча: вызывающий пишет его
 * в журнал с причиной. У соседнего приложения регистрация шла батчем без проверки результата,
 * и провалившаяся уезжала в «установлено»: приложение считалось поставленным, а типа на портале
 * не было.
 */
export async function ensureSurveyResultField(
  call: RestCall,
  handlerUrl: string,
  survey: SmartProcessRef,
  // Поля «Результата опросов», уже прочитанные шагом полей. Поле виджета тот шаг не создаёт,
  // так что список до его создания для этой проверки точен, а второй раз листать его незачем.
  listed?: readonly ExistingField[],
): Promise<ResultFieldOutcome> {
  const app = readAppInfo(await call('app.info', {}))
  if (!app.installed) {
    logger.info({}, 'установка не завершена — поле «Результат опроса» заведёт донастройка')
    return 'deferred'
  }
  if (app.id === null) {
    logger.warn({}, 'портал не назвал идентификатор приложения — поле «Результат опроса» не заведено')
    return 'failed'
  }

  const listing = buildListTypesCall()
  const plan = planTypeRegistration(findRegisteredType(await call(listing.method, listing.params)), handlerUrl)
  if (plan !== 'keep') {
    const register = plan === 'add' ? buildRegisterTypeCall(handlerUrl) : buildUpdateTypeCall(handlerUrl)
    await call(register.method, register.params)
  }

  const name = buildFieldName(survey.id, SURVEY_RESULT_FIELD)
  // Сверка по канонической форме имени: `userfieldconfig.list` отдаёт его в другом написании,
  // и прямое сравнение считало бы существующее поле отсутствующим (разбор — у `buildFieldName`).
  const existing = (listed ?? await listAllFields(call, survey.id))
    .find(field => normalizeFieldName(field.name) === normalizeFieldName(name))
  if (existing !== undefined) {
    if (isOurFieldType(existing.userTypeId, app.id)) return 'ok'
    // Тип виден в журнале целиком: это код типа поля, а не данные клиента.
    logger.warn({ userTypeId: existing.userTypeId }, 'поле «Результат опроса» уже есть, но другого типа — виджет не ставим')
    return 'failed'
  }

  // Тем же билдером, что и прочие поля смарт-процесса: отличается только тип.
  const add = buildCreateFieldCall(survey.id, { postfix: SURVEY_RESULT_FIELD, userTypeId: fullTypeCode(app.id), label: SURVEY_RESULT_TITLE })
  await call(add.method, add.params)
  return 'ok'
}
