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
  SURVEY_FORM_FIELD_TYPE,
  SURVEY_RESULT_FIELD_TYPE,
  SURVEY_RESULT_TITLE,
  buildListTypesCall,
  buildRegisterTypeCall,
  buildUpdateTypeCall,
  findRegisteredType,
  fullTypeCode,
  isOurFieldType,
  planTypeRegistration,
  readAppInfo,
  type FieldTypeSpec,
} from '../domain/portals/userfield-type'
import {
  buildCreateFieldCall,
  buildListSpFieldsCall,
  confirmsFieldOwnership,
  buildCreateSmartProcessCall,
  buildReadCardConfigCall,
  buildReadTypeCall,
  buildSetCardConfigCall,
  buildUpdateRelationsCall,
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
  planDropFieldFromCard,
  planSurveyCard,
  planTemplateCard,
  readTypeRelations,
  planMissingFields,
  readCreatedRef,
  readFields,
  readFlag,
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
  CARD_REVISION,
  TEMPLATE_CARD_REVISION,
  TEMPLATE_FORM_FIELD,
  STAGES_REVISION,
  ourFields,
  type ExistingField,
  type PortalCall,
  type SmartProcessField,
  type SmartProcessRef,
  type CardInput,
  type OwnCardPlan,
} from '../domain/portals/smart-processes'
import {
  SURVEY_STAGES,
  TEMPLATE_STAGES,
  buildCarryListCall,
  buildEnableStagesCall,
  buildListCategoriesCall,
  buildListStagesCall,
  isIssuable,
  isStaged,
  isStateFieldName,
  planStageMoves,
  planStages,
  readCarryItems,
  readDefaultCategoryId,
  readStages,
  surveyMoveOf,
  templateMoveOf,
  type CarryKind,
  type StageSpec,
  type StagedRef,
} from '../domain/portals/stages'
import { parseTemplateSchema } from '../domain/invitations/portal-calls'
import { validateTemplate } from '../domain/surveys/validate'

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
 * ⚠ Вызывающий обязан обернуть `call` в `withDeadline`. Холодная установка — это 53
 * последовательных вызова под троттлингом SDK (число и порядок держит тест «холодная установка:
 * ровно 53 вызова портала» в `tests/unit/provision-outcome.test.ts`); без общего предела одна медленная сеть
 * держит HTTP-запрос установки до таймаута прокси. Предел на один вызов есть в клиенте,
 * но он не ограничивает цепочку целиком.
 */

/**
 * Минимальный вызов портала. Реализация — SDK-клиент, привязанный к порталу.
 *
 * ⚠ Ответ — `result`, `time` и у списков `next`: ровно это отдают оба пути к порталу, SDK
 * (`makePortalCall`) и вебхук операторских команд (`hookCall`). `total` не отдаёт ни один. Пути
 * расходились — вебхук отдавал тело целиком, SDK терял `next`, — и листание в бою видело одну
 * страницу (issue #110). Читать из ответа что-то ещё значит снова развести их.
 */
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
 *
 * ⚠ Списочную команду в пакет не класть: `result_next` команды пакет не отдаёт, и список молча
 * оборвался бы первой страницей — тот же класс, что #110 (`/review` и `/code-review` в PR #113).
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
  /** Адрес страницы поля «Анкета» у «Шаблона опроса» — по тем же правилам, что `resultHandlerUrl`. */
  formHandlerUrl?: string | null
  /** Ревизия, до которой портал был обустроен раньше. От неё зависят разовые правки. */
  previousRevision?: number
}

/**
 * What became of one of our card layouts in one provisioning run:
 * - `written` — written: ours from scratch, or our fields placed into or taken out of the standing one;
 * - `kept` — nothing to write: everything stood, or the one-time fix is not due;
 * - `unreadable` — the standing layout came in a shape we do not understand, and nothing was written;
 * - `foreign` — an adopted smart process whose layout is not ours to change;
 * - `failed` — the portal refused.
 */
export type CardOutcome = 'written' | 'kept' | 'unreadable' | 'foreign' | 'failed'

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
   * Переименовывать и перенастраивать усыновлённый мы не станем (`settleSmartProcesses`). Что мы
   * в нём всё-таки делаем — каждое осознанно: дописываем свои поля и поле виджета, ставим связь
   * со сделкой, снимаем своё поле «Состояние» ревизией 5 (`dropStateField`, там же — почему)
   * и доводим раскладки карточек, где уже стоят наши поля (`planSurveyCard`, `planTemplateCard`).
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
   * What became of the survey card layout (`CardOutcome`).
   *
   * ⚠ Исход, а не «записали или нет»: из пяти исходов строка журнала с доменом пишется только
   * в `register.ts`, и «чужая», «непонятная» и «всё стояло» должны различаться в ней, а не сливаться
   * в `false`. Нашёл `/code-review` во втором круге панели PR #98.
   */
  card: CardOutcome
  /**
   * Доделана ли разовая правка карточки ревизии 6. `false` — отказ, который лечится повтором, у самой
   * правки или у шага поля виджета: вызывающий НЕ отмечает ревизию 6, и донастройка вернётся
   * (`reachedRevision`). Только ниже шестой ревизии (`cardDue`).
   */
  cardSettled: boolean
  /** What became of the template card layout (`CardOutcome`), by the same rules as the survey card (`planTemplateCard`). */
  templateCard: CardOutcome
  /**
   * Доделана ли разовая правка карточки «Шаблона опроса» ревизии 7 — по тем же правилам, что
   * `cardSettled`: `false` держит портал на шестой ревизии. Только ниже седьмой (`TEMPLATE_CARD_REVISION`).
   */
  templateCardSettled: boolean
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
   * Что с полем своего типа «Анкета» у «Шаблона опроса» — по тем же правилам, что `resultField`:
   * `deferred` не отмечает ревизию, `failed` оставляет в карточке схему-JSON и уходит в журнал.
   */
  formField: ResultFieldOutcome
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
  /**
   * Настройка штатных стадий (ревизия 5): включены ли, какая воронка, названия стадий.
   *
   * ⚠ `settled: false` — был отказ, который лечится повтором: ревизию не отмечаем, донастройка
   * вернётся. Перенос элементов со старого поля — отдельный шаг (`carryStates`), у обоих смарт-
   * процессов ПОСЛЕ сохранения идентификаторов с воронками: почему — там.
   */
  stages: StagesOutcome
  /**
   * Our old `STATE` field of each smart process, as the field listing of this run found it; `null` — none.
   *
   * ⚠ Берётся из того же листания полей, что и заведение недостающих, — а не отдельным вызовом
   * перед переносом. Отдельный вызов делал перенос зависимым от ещё одного отказа, и по его
   * временному отказу приложение не знало, есть ли поле вообще: переносить ли с него или его
   * уже нет. Нашли `/review` и `/code-review` во втором круге панели PR #93.
   */
  stateFields: { template: ExistingField | null, survey: ExistingField | null }
}

/** Итог настройки стадий и переноса на них старого поля «Состояние» (ревизия 5). */
export interface StagesOutcome {
  /** Сколько изменяющих вызовов сделано. Ноль — всё уже было на месте. */
  changes: number
  /**
   * Всё доделано. `false` — донастройка обязана вернуться:
   * - у настройки стадий — отказ, который лечится повтором (`isRetryableRefusal`). Отказ, который
   *   повтор не вылечит, — тариф не даёт включить стадии, — сюда не считается: такой смарт-процесс
   *   остаётся на старом поле, и возвращаться к нему каждый час незачем;
   * - у переноса — ЛЮБОЙ незаконченный исход: отказ, предел страниц, свой предел времени. Иначе
   *   ревизия 5 отметилась бы, и перенос не запустился бы больше никогда — элементы остались бы
   *   в первой стадии навсегда. Нашли программист, `/review` и `/code-review` в панели PR #93.
   */
  settled: boolean
}

/**
 * How long the one-off carry may run within one provisioning, ms.
 *
 * ⚠ Свой предел, а не общий бюджет обустройства (`PROVISION_BUDGET_MS`): перенос — единственный
 * шаг, чья цена растёт с числом элементов. Упрись он в общий предел, прогон кончился бы `failed`,
 * портал ушёл бы в `degraded`, а отметку ревизии и вкладки было бы нечем записать. Не успел —
 * ревизия не отмечается, и следующая донастройка продолжит: переведённые из отбора уже выпали.
 */
export const CARRY_BUDGET_MS = 15_000

/**
 * What the carry leaves of the whole provisioning budget for the steps after it, ms.
 *
 * ⚠ Предел переноса — внутри общего, а не рядом. Первая редакция отсчитывала свои пятнадцать секунд
 * от конца обустройства, и на медленном портале (0,7 с на вызов) перенос упирался в общий предел:
 * прогон кончался `failed`, портал уходил в `degraded` — ровно то, от чего свой предел заводился.
 * После переноса ещё удаление поля, раскладка карточки и отметка ревизии — до четырёх вызовов.
 * Нашли `/review` и `/code-review` во втором круге панели PR #93 — пробой на подделке портала.
 */
export const CARRY_TAIL_RESERVE_MS = 8_000

/** One carry run: when it must stop starting new calls, and which portal it works on. `now` is injectable for tests. */
export interface CarryRun {
  deadline: number
  now: () => number
  /**
   * The portal's domain — for the log only.
   *
   * ⚠ Номер смарт-процесса у каждого портала свой и портала не называет, а строка переноса бывает
   * единственным следом застрявшей анкеты: без домена дежурный не знал бы, кому звонить. Нашёл
   * `/review` в закрывающем проходе панели PR #93.
   */
  domain: string
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
 * и разовые шаги повторялись бы каждый час, возвращая клиенту то, что он убрал сам. Первая
 * редакция считала это у вызывающего особым случаем; `/review` во втором круге PR #87 заметил,
 * что следующая миграция добавила бы туда второй — поэтому здесь.
 */
export function reachedRevision(
  previous: number,
  result: Pick<ProvisionResult, 'resultField' | 'formField' | 'ownership' | 'stages' | 'cardSettled' | 'templateCardSettled'>,
  carried: StagesOutcome | null = null,
): number {
  // Оба поля своего типа откладываются вместе — по одному и тому же `app.info`.
  if (result.resultField === 'deferred' || result.formField === 'deferred') return previous
  const ownership = result.ownership
  if (ownership !== null && (!ownership.fieldsLocked || !ownership.settled)) return Math.max(previous, OWNERSHIP_REVISION - 1)
  // Стадии не доделаны — портал на ревизии до них: всё прежнее на месте, донастройка вернётся.
  // ⚠ Без `Math.max`, в отличие от строки выше: портал, уже отмеченный пятой, тоже опускается
  // до четвёртой. Иначе смарт-процесс, пересозданный на нём, с неудавшейся воронкой не вернулся
  // бы к донастройке никогда: `max(5, 4)` — снова пять. Нашёл `/code-review` в панели PR #93.
  // ⚠ Разовые шаги ниже пятой ревизии закрыты воротами «меньше», и повтор их не тронет, а правку
  // карточки ревизии 6 портал ниже шестой получит снова. На уже поправленной раскладке она ничего
  // не пишет, но то, что клиент поменял в карточке после неё, вернёт. Размен принят: опуститься
  // ниже шестой портал может, только если его смарт-процесс пересоздали и воронка не прочиталась
  // (разбор — `docs/PROCESS.md`, раздел 9). Нашли `/review` и `/code-review` в панели PR #98.
  if (!result.stages.settled || carried?.settled === false) return STAGES_REVISION - 1
  // Карточка не доделана — портал на ревизии до неё: стадии и всё прежнее на месте. `cardSettled`
  // бывает `false` только ниже шестой — правку держит гейт `cardDue`, — так что `Math.max` здесь
  // ничего бы не изменил.
  if (!result.cardSettled) return CARD_REVISION - 1
  // Карточка «Шаблона» не доделана — портал на шестой: всё прежнее, включая карточку «Результата», на месте.
  if (!result.templateCardSettled) return TEMPLATE_CARD_REVISION - 1
  return PROVISION_REVISION
}

function validRef(ref: SmartProcessRef | undefined): SmartProcessRef | undefined {
  if (ref === undefined) return undefined
  const ok = Number.isInteger(ref.entityTypeId) && ref.entityTypeId > 0
    && Number.isInteger(ref.id) && ref.id > 0
  if (!ok) return undefined
  // ⚠ Воронка — только настоящая. Испорченная отметка включила бы режим стадий с кодами,
  // которых на портале нет, а неизвестную стадию портал молча отбрасывает (замерено 28.09).
  const staged = Number.isInteger(ref.categoryId) && (ref.categoryId as number) > 0
  return { entityTypeId: ref.entityTypeId, id: ref.id, ...(staged ? { categoryId: ref.categoryId } : {}) }
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

/** One of our cards: how its layout is planned, and how the log names it. */
interface OwnCard {
  plan: (current: unknown, spTypeId: number, card: CardInput) => OwnCardPlan
  /** The smart process the card belongs to, in the genitive, as the log says it: «Результата опросов». */
  name: string
}

const SURVEY_OWN_CARD: OwnCard = { plan: planSurveyCard, name: 'Результата опросов' }
const TEMPLATE_OWN_CARD: OwnCard = { plan: planTemplateCard, name: 'Шаблона опроса' }

/**
 * Puts one of our card layouts in order (`planSurveyCard`, `planTemplateCard`) and tells what became of it.
 *
 * Разложить карточку так, чтобы в ней было видно главное: у «Результата опросов» — сделку, клиента
 * и результат, у «Шаблона опроса» — саму анкету (#84, п. 18).
 *
 * ⚠ Целиком — только на ПУСТОМ месте. `crm.item.details.configuration.set` перезаписывает
 * раскладку целиком и сразу для всех пользователей — это настройка клиента, а не наша.
 * Разложивший карточку под себя получал бы нашу при каждой переустановке; такого мы уже
 * натворили бы со связями, если бы не сливали их. Поэтому сначала читаем, и ставим, только
 * если пусто.
 *
 * ⚠ Если раскладка уже стоит — правим в ней только свои поля (`planSurveyCard`, там же —
 * почему и где), и только при переходе на ревизию карточки (`due`): повторяясь при каждом
 * обустройстве, правка возвращала бы клиенту поля, которые он убрал сам.
 *
 * `widget` — заведено ли поле виджета. Без него раскладка остаётся при JSON: ставить в карточку
 * поле, которого на элементе нет, значит показать пустое место вместо ответов.
 *
 * ⚠ У УСЫНОВЛЁННОГО (`adopted`) раскладку с нуля не ставим, а стоящую правим, только если она уже
 * знает хоть одно наше поле (`planSurveyCard`, там же — почему). Найденный по названию может оказаться
 * собственным «Опросом» клиента, и наша раскладка целиком легла бы в его карточку у всех. Нашли
 * `/review` и `/code-review` в панели PR #98.
 */
async function ensureCardConfig(
  call: RestCall,
  ref: SmartProcessRef,
  card: Omit<CardInput, 'staged'>,
  own: OwnCard,
): Promise<Exclude<CardOutcome, 'failed'>> {
  const read = buildReadCardConfigCall(ref.entityTypeId)
  const plan = own.plan(await call(read.method, read.params), ref.id, { ...card, staged: isStaged(ref) })
  if (plan.kind === 'unreadable') {
    // Не разобрав, не пишем — но и молчать нельзя: виджета в карточке не будет, а JSON останется,
    // и узнать это надо из журнала, а не от клиента.
    logger.warn({ typeId: ref.id }, `раскладка карточки «${own.name}» непонятной формы — наши поля не поставлены, JSON не убран`)
    return 'unreadable'
  }
  if (plan.kind === 'foreign') {
    logger.info({ typeId: ref.id }, `усыновлённый смарт-процесс: раскладка карточки «${own.name}» не наша — не трогаем и нашу не ставим`)
    return 'foreign'
  }
  if (plan.kind === 'keep') return 'kept'

  const set = buildSetCardConfigCall(ref.entityTypeId, plan.sections)
  await call(set.method, set.params)
  return 'written'
}

/**
 * Lays out one of our cards (`ensureCardConfig`) and tells whether its one-time fix is done.
 *
 * ⚠ Раскладка карточки — удобство, и её неудача установку не роняет: без неё приложение работает
 * целиком, просто карточка выглядит хуже. Роняя установку из-за косметики, мы поменяли бы местами
 * главное и второстепенное.
 *
 * ⚠ «Разово» держит гейт `due`: правка положена только порталу ниже ревизии карточки. На отказе,
 * который лечится повтором, она держит ревизию: отметив её, мы не вернулись бы к карточке никогда.
 * Отказ, который повтор не вылечит, — только журнал.
 *
 * ⚠ Повторимый отказ шага поля виджета держит правку так же, как её собственный: без поля правка
 * сняла бы не всё, ревизия отметилась бы — и к карточке мы не вернулись бы никогда (`/review`
 * и `/code-review` в панели PR #98). Держит при ЛЮБОМ исходе карточки: повтор — ещё и единственная
 * попытка завести само поле, а ждать приходится, только пока шаг падает. Второй круг PR #98 снимал
 * удержание ради чужой и непонятной раскладки — и поле после сбоя связи не заводилось больше никогда:
 * донастройка не берёт порталы, отмеченные ревизией. Разбор — `docs/PROCESS.md`, раздел 9.
 *
 * Одно правило на обе карточки: в PR #100 оно было переписано в двух местах, а правили его по ревью
 * уже трижды — расхождение дало бы портал, навсегда застрявший ниже ревизии. Нашёл `/code-review`.
 */
async function settleOwnCard(
  call: RestCall,
  sp: { ref: SmartProcessRef, adopted: boolean },
  own: OwnCard,
  due: boolean,
  widget: WidgetFieldResult,
): Promise<{ outcome: CardOutcome, settled: boolean }> {
  let outcome: CardOutcome = 'failed'
  let settled = true
  try {
    outcome = await ensureCardConfig(call, sp.ref, { widget: widget.outcome === 'ok', due, adopted: sp.adopted }, own)
  }
  catch (error) {
    if (due && isRetryableRefusal(error)) settled = false
    logger.warn({ reason: safeRefusal(error) }, `раскладка карточки «${own.name}» не настроена`)
  }
  if (due && widget.refusal !== null && isRetryableRefusal(widget.refusal)) settled = false
  return { outcome, settled }
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

  // ⚠ Стадии — СРАЗУ после поиска и ДО полей: от них зависит, нужно ли своё поле «Состояние»
  // вообще (`ourFields`). Разово, при переходе на ревизию 5, — и всегда у смарт-процесса, созданного
  // этим запуском: он уже со стадиями, и остаётся настроить воронку. Иначе пересозданный на портале
  // ревизии 5 получил бы стадии без воронки в ссылке, то есть поле «Состояние» заново и канбан,
  // где всё стоит в первой стадии.
  const stages: StagesOutcome = { changes: 0, settled: true }
  const stagesDue = (options.previousRevision ?? 0) < STAGES_REVISION
  if (stagesDue || template.created) template.ref = await setUpStages(call, template, types, Object.values(TEMPLATE_STAGES), stages)
  if (stagesDue || survey.created) survey.ref = await setUpStages(call, survey, types, Object.values(SURVEY_STAGES), stages)

  const templateFields = await ensureFields(call, template.ref, ourFields(TEMPLATE_FIELDS, template.ref))
  const surveyFields = await ensureFields(call, survey.ref, ourFields(SURVEY_FIELDS, survey.ref))

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
  const resultHandlerUrl = options.resultHandlerUrl ?? null
  const formHandlerUrl = options.formHandlerUrl ?? null
  const widgets = await ensureWidgetFields(call, {
    result: resultHandlerUrl === null ? null : { type: SURVEY_RESULT_FIELD_TYPE, handlerUrl: resultHandlerUrl, ref: survey.ref, postfix: SURVEY_RESULT_FIELD, listed: surveyFields.existing },
    form: formHandlerUrl === null ? null : { type: SURVEY_FORM_FIELD_TYPE, handlerUrl: formHandlerUrl, ref: template.ref, postfix: TEMPLATE_FORM_FIELD, listed: templateFields.existing },
  })
  const resultField = widgets.result.outcome
  const formField = widgets.form.outcome

  // Обе карточки — одним правилом (`settleOwnCard`): «Результата опросов» с ревизии 6, «Шаблона
  // опроса» с ревизии 7 (#84, п. 18); до неё раскладку «Шаблона» мы не ставили вовсе.
  const previous = options.previousRevision ?? 0
  const surveyCard = await settleOwnCard(call, survey, SURVEY_OWN_CARD, previous < CARD_REVISION, widgets.result)
  const templateCard = await settleOwnCard(call, template, TEMPLATE_OWN_CARD, previous < TEMPLATE_CARD_REVISION, widgets.form)

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
    card: surveyCard.outcome,
    cardSettled: surveyCard.settled,
    templateCard: templateCard.outcome,
    templateCardSettled: templateCard.settled,
    resultField,
    formField,
    crmFields,
    ownership,
    stages,
    stateFields: { template: stateFieldIn(templateFields.existing, template.ref), survey: stateFieldIn(surveyFields.existing, survey.ref) },
  }
}

/** Our `STATE` field among the fields a smart process had before this run, if any. */
function stateFieldIn(fields: readonly ExistingField[], ref: SmartProcessRef): ExistingField | null {
  return fields.find(field => isStateFieldName(ref, field.name)) ?? null
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
 * Turns native stages on for one of our smart processes and sets up its funnel; returns the ref.
 *
 * Возвращённая ссылка несёт `categoryId`, только если стадии включены и воронка прочитана: он и есть
 * признак «элементы живут на стадиях» (`server/domain/portals/stages.ts`). Не вышло — ссылка без
 * него, и смарт-процесс остаётся на старом поле «Состояние», как до ревизии 5.
 *
 * ⚠ УСЫНОВЛЁННЫЙ — ТОЛЬКО ЧТЕНИЕМ. Найденный по названию может оказаться чужим (разбор у
 * `settleSmartProcesses`): включив ему стадии и переименовав их, мы переделали бы клиенту его
 * процесс. Но и отказываться от чтения нельзя: чаще всего это НАШ смарт-процесс, переживший
 * переустановку, — уже переведённый на стадии, с удалённым полем «Состояние». Не узнав его воронку,
 * приложение завело бы поле заново, пустым, и все опубликованные анкеты перестали бы читаться.
 * Поэтому воронку берём, если стадии там уже включены, а сами ничего не включаем и не называем.
 * Нашли `/review`, `/code-review` и программист в панели PR #93.
 *
 * ⚠ Тариф может не дать включить стадии (`UPDATE_DYNAMIC_TYPE_RESTRICTED`). Это не повод
 * возвращаться каждый час: смарт-процесс работает и на старом поле. Громко, ошибкой — чтобы
 * «канбана нет» узнавалось из журнала, а не от клиента.
 */
async function setUpStages(
  call: RestCall,
  sp: EnsuredSmartProcess,
  types: readonly Record<string, unknown>[],
  specs: readonly StageSpec[],
  outcome: StagesOutcome,
): Promise<SmartProcessRef> {
  let ref: SmartProcessRef = sp.ref
  if (isStaged(ref)) return sp.adopted ? ref : await nameStages(call, ref, specs, outcome)

  if (sp.adopted) {
    // ⚠ НЕ УЗНАЛИ — ОБУСТРОЙСТВО ПАДАЕТ, а не идёт дальше старым полем. Здесь, в отличие от своего
    // смарт-процесса, поля «Состояние» может уже не быть: пойдя дальше без воронки, обустройство
    // завело бы его заново, пустым, и до следующей донастройки все опубликованные анкеты читались бы
    // из пустоты — не выпускались бы и правились. Упавшее обустройство — это «ещё настраивается»
    // и повтор, а не чтение неправды. Нашёл `/code-review` во втором круге панели PR #93.
    if (!await stagesAlreadyOn(call, ref, types)) return ref
    const list = buildListCategoriesCall(ref)
    const categoryId = readDefaultCategoryId(await call(list.method, list.params))
    if (categoryId === null) throw new Error('стадии усыновлённого смарт-процесса включены, а воронка по умолчанию не найдена')
    return { ...ref, categoryId }
  }
  // Созданный этим запуском уже со стадиями (`buildCreateSmartProcessCall`); включать незачем.
  if (!sp.created) {
    const enable = buildEnableStagesCall(ref)
    try {
      await call(enable.method, enable.params)
      outcome.changes++
    }
    catch (error) {
      refuseStages(outcome, 'включение стадий', error, ref)
      return ref
    }
  }

  try {
    const list = buildListCategoriesCall(ref)
    const categoryId = readDefaultCategoryId(await call(list.method, list.params))
    if (categoryId === null) {
      // Воронка по умолчанию есть всегда (замерено 28.09); ответ без неё — не той формы.
      // Повтор, скорее всего, не поможет, но и режим стадий без воронки не включить.
      logger.warn({ typeId: ref.id }, 'стадии: воронка по умолчанию не найдена в ответе')
      return ref
    }
    ref = { ...ref, categoryId }
  }
  catch (error) {
    refuseStages(outcome, 'воронка', error, ref)
    return ref
  }

  return await nameStages(call, ref as StagedRef, specs, outcome)
}

/**
 * Whether a smart process already has native stages on: from the type list, or asked by id.
 *
 * Список типов есть, только если поиск его листал; усыновлённый прошлым прогоном находится
 * по сохранённому идентификатору, и тогда спрашиваем тип отдельно.
 */
async function stagesAlreadyOn(
  call: RestCall,
  ref: SmartProcessRef,
  types: readonly Record<string, unknown>[],
): Promise<boolean> {
  const listed = types.find(type => Number(type.id) === ref.id)
  if (listed !== undefined) return readFlag(listed.isStagesEnabled) === true
  const read = buildReadTypeCall(ref)
  const type = (await call(read.method, read.params) as { result?: { type?: { isStagesEnabled?: unknown } } } | null)?.result?.type
  return readFlag(type?.isStagesEnabled) === true
}

/**
 * Names our stages and drops the unused ones. Only what still carries the portal's own name.
 *
 * Отказ здесь режим стадий не отменяет: стадии включены, и элементы уже живут на них — не доехали
 * только наши названия, и донастройка их довезёт.
 */
async function nameStages(
  call: RestCall,
  ref: StagedRef,
  specs: readonly StageSpec[],
  outcome: StagesOutcome,
): Promise<StagedRef> {
  try {
    const list = buildListStagesCall(ref)
    const existing = readStages(await call(list.method, list.params), ref)
    for (const update of existing === null ? [] : planStages(specs, existing)) {
      try {
        await call(update.method, update.params)
        outcome.changes++
      }
      catch (error) {
        refuseStages(outcome, 'стадии', error, ref)
      }
    }
  }
  catch (error) {
    refuseStages(outcome, 'стадии', error, ref)
  }
  return ref
}

/**
 * Carries the old `STATE` field of one smart process over to its stages. `true` — nothing is left.
 *
 * `field` — our `STATE` field as this run's field listing found it (`ProvisionResult.stateFields`);
 * `null` — переносить нечего: поле удалил прошлый прогон или его не было вовсе.
 *
 * Revision 5, once, AFTER the refs with funnels are saved (`register.ts`): доставка пишет опросы
 * одновременно с переносом, и опрос, пройденный между переносом и сохранением, остался бы
 * «Отправленным» навсегда. До переноса неперенесённые элементы читаются правильно и так: опросы —
 * по дате прохождения и нашей базе, шаблоны — по старому полю, пока перенос его не снял
 * (`templateStateOf`). С переведённого шаблона перенос снимает старое поле той же записью.
 *
 * ⚠ НЕЗАКОНЧЕННЫЙ ИСХОД — `false`, и поле тогда не удаляется: удаление необратимо. Держит ли он
 * ревизию, решает `unfinished`: свой предел времени (`CARRY_BUDGET_MS`), предел страниц, ответ,
 * который не прочитать, и повторимый отказ — держат, отказ, который повтор не вылечит, — нет.
 *
 * ⚠ Строка отбора, в которой не видно того, по чему отбирали, — тоже незаконченный перенос, а не
 * «переводить нечего». Иначе расхождение формы (другое написание поля, другой `id`) выглядело бы
 * чистым проходом без единого перевода, и поле удалилось бы вместе с состоянием всех элементов.
 * Нашли `/review` и `/code-review` во втором круге панели PR #93.
 */
export async function carryStates(
  call: RestCall,
  ref: StagedRef,
  kind: CarryKind,
  field: ExistingField | null,
  outcome: StagesOutcome,
  run: CarryRun,
): Promise<boolean> {
  if (field === null) return true

  const moveOf = kind === 'template' ? templateMoveOf(ref, new Date(run.now()).toISOString().slice(0, 10)) : surveyMoveOf(ref)
  let clean = true
  let after = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    if (run.now() >= run.deadline) return unfinished(outcome, run, 'перенос состояния: время вышло', ref)
    let response: unknown
    try {
      const list = buildCarryListCall(ref, kind, after)
      response = await call(list.method, list.params)
    }
    catch (error) {
      return unfinished(outcome, run, 'перенос состояния', ref, error)
    }
    const items = readCarryItems(response, ref, kind)
    if (items === null) return unfinished(outcome, run, 'перенос состояния: ответ не прочитать', ref)
    // В отчёт — только то, что после перевода останется выпускаемым: строку с чужим значением перевод
    // пропускает, а снятая или уведённая администратором в свою стадию не выпускается и так — «выпуск
    // по ним сохранён» о них соврал бы. Нашёл `/code-review` в панели PR #93.
    if (kind === 'template') {
      reportUnchecked(ref, run, items.filter((item) => {
        const move = moveOf(item)
        return move !== null && isIssuable(ref, { ...item, ...move })
      }))
    }
    for (const move of planStageMoves(ref, items, moveOf)) {
      if (run.now() >= run.deadline) return unfinished(outcome, run, 'перенос состояния: время вышло', ref)
      try {
        await call(move.method, move.params)
        outcome.changes++
      }
      catch (error) {
        clean = unfinished(outcome, run, 'перенос состояния', ref, error, Number(move.params.id))
      }
    }
    if (readNextOffset(response) === null) return clean
    // Портал говорит «есть ещё», а курсор не двигается — дальше не прочитать, это не «всё».
    const last = Number(items.at(-1)?.id)
    if (!Number.isInteger(last) || last <= after) return unfinished(outcome, run, 'перенос состояния: листание не продвигается', ref)
    after = last
  }
  // Упёрлись в предел страниц — перенесли не всё, и поле удалять нельзя.
  return unfinished(outcome, run, 'перенос состояния: предел страниц', ref)
}

/**
 * Deletes our `STATE` field of a smart process now living on stages, and its name from the card.
 * No field — nothing to do.
 *
 * ⚠ Только после ЧИСТОГО переноса — решение владельца «свои упраздни». Удаление необратимо:
 * не переведя хоть один элемент, мы потеряли бы его состояние вместе с полем.
 *
 * ⚠ У УСЫНОВЛЁННОГО — ТОЖЕ, и это решение, а не недосмотр (безопасность во втором круге панели
 * PR #93 спросила прямо). Поле называется `UF_CRM_<id>_STATE` по номеру самого смарт-процесса,
 * и заводим его мы; перенос переводит только элементы с нашими значениями в нём, то есть наши.
 * Чаще всего усыновлённый — наш же, переживший переустановку посреди миграции, и оставить ему
 * поле значило бы не довести миграцию никогда.
 */
export async function dropStateField(
  call: RestCall,
  ref: StagedRef,
  field: ExistingField | null,
  outcome: StagesOutcome,
  run: CarryRun,
): Promise<void> {
  if (field === null) return
  if (run.now() >= run.deadline) {
    unfinished(outcome, run, 'удаление поля «Состояние»: время вышло', ref)
    return
  }
  if (field.id === 0) {
    // Удалять нечем: портал не назвал идентификатор настроек. Поле остаётся, и это видно.
    logger.warn({ domain: run.domain, typeId: ref.id }, 'стадии: поле «Состояние» не удалено — портал не назвал его идентификатор')
    return
  }
  try {
    await call('userfieldconfig.delete', { moduleId: 'crm', id: field.id })
    outcome.changes++
  }
  catch (error) {
    refuseStages(outcome, 'удаление поля «Состояние»', error, ref)
    return
  }

  // Раскладка карточки — удобство: её отказ перенос не держит, поле уже удалено.
  try {
    const read = buildReadCardConfigCall(ref.entityTypeId)
    const plan = planDropFieldFromCard(await call(read.method, read.params), ref.id, 'STATE')
    // Не разобрав, не пишем — но и молчать нельзя: имя без поля в карточке останется.
    if (plan.kind === 'unreadable') logger.warn({ domain: run.domain, typeId: ref.id }, 'стадии: раскладка карточки непонятной формы — имя поля «Состояние» в ней осталось')
    if (plan.kind !== 'write') return
    const set = buildSetCardConfigCall(ref.entityTypeId, plan.sections)
    await call(set.method, set.params)
    outcome.changes++
  }
  catch (error) {
    logger.warn({ domain: run.domain, typeId: ref.id, reason: safeRefusal(error) }, 'стадии: имя поля «Состояние» осталось в раскладке карточки')
  }
}

/**
 * Tells the log about templates published before the schema check existed, and the carry keeps them.
 *
 * ⚠ Перенос досылает дату публикации анкетам, опубликованным правкой поля, — то есть без проверки
 * схемы, которую с #77 делает публикация. Выпускать по ним можно было и до ревизии 5, так что
 * перенос ничего не расширяет; но и молча принять их за проверенные нельзя. В журнал — коды
 * и версии, без схем: схема — текст клиента. Нашла безопасность в панели PR #93.
 *
 * ⚠ Только журнал, и потому НИКОГДА не бросает. Проверка схемы рассчитана на схемы из конструктора,
 * а здесь бывают правленные руками — без названия или диапазонов; брошенное ею исключение уронило бы
 * всё обустройство, и миграция не закончилась бы никогда. Такая схема — тоже «не проходит проверку».
 * Нашёл `/review` во втором круге панели PR #93.
 */
function reportUnchecked(ref: StagedRef, run: CarryRun, items: readonly Record<string, unknown>[]): void {
  const field = (postfix: string) => buildFieldName(ref.id, postfix)
  const label = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '?'
  const unchecked = items.flatMap((item) => {
    const dated = item[field('PUBLISHED_AT')]
    if (typeof dated === 'string' && dated !== '') return []
    let broken: boolean
    try {
      const schema = parseTemplateSchema(item[field('SCHEMA')])
      broken = schema === null || validateTemplate(schema).some(problem => problem.level === 'error')
    }
    catch {
      broken = true
    }
    return broken ? [`${label(item[field('CODE')])} v${label(item[field('VERSION')])}`] : []
  })
  if (unchecked.length > 0) {
    logger.warn({ domain: run.domain, typeId: ref.id, unchecked }, 'стадии: опубликованные до проверки схемы анкеты не проходят её — выпуск по ним сохранён')
  }
}

/**
 * Marks the carry unfinished and says why. Returns `false`.
 *
 * ⚠ Ревизию держит всё, что лечится повтором: свой предел времени, предел страниц, ответ, который
 * не прочитать, повторимый отказ портала. Отказ, который повтор не вылечит (права, обязательное
 * по стадии поле клиента на одном элементе), — ошибкой в журнал, и ревизию он НЕ держит: иначе
 * один такой элемент гонял бы донастройку портала каждый час бесконечно. Тот же размен, что
 * у `refuse` ревизии 4. Поле в обоих случаях остаётся: перенос не чистый. Нашёл `/code-review`
 * во втором круге панели PR #93.
 *
 * ⚠ `itemId` — номер элемента, на котором отказал перевод. После отказа, который повтор не вылечит,
 * элемент так и стоит в первой стадии со старым полем, а перенос к нему не вернётся: ревизия
 * отмечена. Шаблон при этом выпускается, как до ревизии 5, хотя канбан показывает «Черновик»
 * (`isIssuable`), — и найти его, кроме как по этой строке журнала, нечем. Что с ним делать —
 * в `docs/PROCESS.md`. Номер элемента нашего смарт-процесса — не идентификатор клиента.
 * Нашёл `/code-review` в панели PR #93.
 */
function unfinished(outcome: StagesOutcome, run: CarryRun, step: string, ref: SmartProcessRef, error?: unknown, itemId?: number): false {
  const context = {
    domain: run.domain,
    step,
    typeId: ref.id,
    ...(itemId === undefined ? {} : { itemId }),
    ...(error === undefined ? {} : { reason: safeRefusal(error) }),
  }
  if (error !== undefined && !isRetryableRefusal(error)) {
    logger.error(context, 'стадии: перенос не доделан, портал отказал — повтор не поможет')
    return false
  }
  outcome.settled = false
  logger.warn(context, 'стадии: перенос не доделан, донастройка вернётся')
  return false
}

/**
 * Sorts a refusal of a stages step: worth a retry — revision 5 stays unfinished; not — let it go, loudly.
 *
 * Тот же размен, что у `refuse` ревизии 4: держим ревизию только на отказе, который лечится повтором.
 * Остальное — тариф, права — ошибкой в журнал: смарт-процесс работает и на старом поле, но клиент
 * не получит канбана, и знать об этом надо из журнала. Слова портала в журнал не попадают.
 */
function refuseStages(outcome: StagesOutcome, step: string, error: unknown, ref: SmartProcessRef): void {
  if (isRetryableRefusal(error)) {
    outcome.settled = false
    logger.warn({ step, typeId: ref.id, reason: safeRefusal(error) }, 'стадии: шаг не удался, донастройка вернётся')
    return
  }
  logger.error({ step, typeId: ref.id, reason: safeRefusal(error) }, 'стадии: портал отказал, повтор не поможет')
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

/** One field of our own type to set up: its type, where its page lives, its smart process and postfix. */
export interface WidgetTarget {
  type: FieldTypeSpec
  handlerUrl: string
  ref: SmartProcessRef
  postfix: string
  /**
   * Поля смарт-процесса, уже прочитанные шагом полей. Поле виджета тот шаг не создаёт, так что
   * список до его создания для этой проверки точен, а второй раз листать его незачем.
   */
  listed?: readonly ExistingField[]
}

/** What became of one widget field, and the portal's refusal when there was one. */
export interface WidgetFieldResult {
  outcome: ResultFieldOutcome
  refusal: unknown
}

/** Our two widget fields; `null` — not set up this run (no https host). */
export interface WidgetTargets {
  result: WidgetTarget | null
  form: WidgetTarget | null
}

const NOT_SET_UP: WidgetFieldResult = { outcome: 'failed', refusal: null }

/**
 * Завести поля своего типа — виджеты, которые показывают словами то, что лежит в карточках простынёй
 * JSON: «Результат опроса» на «Результате опросов» и «Анкету» на «Шаблоне опроса» (#84, п. 18).
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
 * ⚠ `app.info` и список типов — ОДИН раз на оба поля: приложение и его регистрации у них общие.
 * Их отказ — общий для обоих полей; отказ на одном поле остаётся при нём (`refusal`) и второе не держит.
 *
 * ⚠ НИЧЕГО НЕ БРОСАЕТ, но и не молчит: всякий отказ — строка в журнале с причиной и `failed`
 * с этим отказом у поля. У соседнего приложения регистрация шла батчем без проверки результата,
 * и провалившаяся уезжала в «установлено»: приложение считалось поставленным, а типа на портале
 * не было. Установку отказ не роняет: без виджета данные на месте, в карточке остаётся JSON.
 */
async function ensureWidgetFields(call: RestCall, targets: WidgetTargets): Promise<Record<keyof WidgetTargets, WidgetFieldResult>> {
  /** The same result for every field this run sets up; `NOT_SET_UP` for the ones it does not. */
  const each = (result: WidgetFieldResult) => ({
    result: targets.result === null ? NOT_SET_UP : result,
    form: targets.form === null ? NOT_SET_UP : result,
  })
  // Нет https-хоста — ни одного вызова: заводить нечего (`buildTabHandlerUrl`).
  if (targets.result === null && targets.form === null) return each(NOT_SET_UP)

  let appId: number
  let registered: unknown
  try {
    const app = readAppInfo(await call('app.info', {}))
    if (!app.installed) {
      logger.info({}, 'установка не завершена — поля своего типа заведёт донастройка')
      return each({ outcome: 'deferred', refusal: null })
    }
    if (app.id === null) {
      logger.warn({}, 'портал не назвал идентификатор приложения — поля своего типа не заведены')
      return each(NOT_SET_UP)
    }
    appId = app.id
    const listing = buildListTypesCall()
    registered = await call(listing.method, listing.params)
  }
  catch (error) {
    logger.warn({ reason: safeRefusal(error) }, 'поля своего типа не заведены: портал не ответил о приложении или о типах')
    return each({ outcome: 'failed', refusal: error })
  }

  const one = async (target: WidgetTarget | null): Promise<WidgetFieldResult> => {
    if (target === null) return NOT_SET_UP
    try {
      return { outcome: await ensureWidgetField(call, target, appId, registered), refusal: null }
    }
    catch (error) {
      logger.warn({ reason: safeRefusal(error) }, `поле «${target.type.title}» не заведено`)
      return { outcome: 'failed', refusal: error }
    }
  }
  // По очереди, не разом: в батч регистрация типа не кладётся, а параллельные записи в один
  // портал упираются в его же предел запросов.
  const result = await one(targets.result)
  const form = await one(targets.form)
  return { result, form }
}

/** Registers one type of ours if needed and creates its field on the smart process: `ok`, or `failed` when a foreign field holds the name. */
async function ensureWidgetField(call: RestCall, target: WidgetTarget, appId: number, registered: unknown): Promise<ResultFieldOutcome> {
  const { type, handlerUrl, ref, postfix } = target
  const plan = planTypeRegistration(findRegisteredType(registered, type.code), handlerUrl)
  if (plan !== 'keep') {
    const register = plan === 'add' ? buildRegisterTypeCall(type, handlerUrl) : buildUpdateTypeCall(type, handlerUrl)
    await call(register.method, register.params)
  }

  const name = buildFieldName(ref.id, postfix)
  // Сверка по канонической форме имени: `userfieldconfig.list` отдаёт его в другом написании,
  // и прямое сравнение считало бы существующее поле отсутствующим (разбор — у `buildFieldName`).
  const existing = (target.listed ?? await listAllFields(call, ref.id))
    .find(field => normalizeFieldName(field.name) === normalizeFieldName(name))
  if (existing !== undefined) {
    if (isOurFieldType(existing.userTypeId, appId, type.code)) return 'ok'
    // Тип виден в журнале целиком: это код типа поля, а не данные клиента.
    logger.warn({ userTypeId: existing.userTypeId }, `поле «${type.title}» уже есть, но другого типа — виджет не ставим`)
    return 'failed'
  }

  // Тем же билдером, что и прочие поля смарт-процесса: отличается только тип.
  const add = buildCreateFieldCall(ref.id, { postfix, userTypeId: fullTypeCode(appId, type.code), label: type.title })
  await call(add.method, add.params)
  return 'ok'
}
