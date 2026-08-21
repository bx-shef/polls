import type { CompiledVersion, EntityType, ResponseRecord, SurveyDraft } from '../domain/schema'
import type { CsatSummary, NpsSummary } from '../domain/metrics'
import type { BreakdownRow, TrendPoint } from '../domain/aggregate'

/** Что дашборд просит у хранилища за один заход (#49). */
export interface DashboardQuery {
  surveyKey: string
  /** Срез по одной версии; `undefined` — все версии. */
  versionNo?: number
  /** Ключ вопроса-метрики NPS из текущей версии; нет — NPS не считается. */
  npsKey?: string
  /** Ключ вопроса-метрики CSAT; нет — CSAT не считается. */
  csatKey?: string
  /** Ключ вопроса с выбором варианта; нет — распределения не будет. */
  choiceKey?: string
}

/**
 * Готовые агрегаты дашборда. Формы совпадают с `src/domain/aggregate` — это тот же контракт,
 * посчитанный другим способом.
 */
export interface DashboardAggregates {
  /** Число ответов ПОСЛЕ фильтра по версии. */
  n: number
  /** Все версии, по которым есть ответы, — ДО фильтра (иначе селектор версий схлопывается). */
  versions: number[]
  nps: NpsSummary | null
  csat: CsatSummary | null
  /** Сырые счётчики по `option_key`; k-анонимность ячеек — на потребителе (см. `dashboardAggregates`). */
  distribution: Record<string, number> | null
  trend: TrendPoint[]
  services: BreakdownRow[]
  directions: BreakdownRow[]
  responsibles: BreakdownRow[]
  clients: BreakdownRow[]
}

/** Размер страницы read-API: дефолт и потолок (защита от тяжёлых выборок). */
export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 500

/**
 * Минимальный контракт драйвера БД (совместим с pg.Pool и PGlite). Живёт здесь
 * (а не в `store/pg`), потому что это cross-cutting инфраструктурный интерфейс:
 * им пользуются и `PgStore`, и `bitrix24/PortalTokenStore` — слой `bitrix24` не
 * должен зависеть от файла с реализацией `PgStore`+SQL.
 * `transaction` опциональна: PGlite даёт её из коробки; для `pg.Pool` используйте
 * фабрику `queryableFromPool` (store/pg) — она строит корректный транзакционный
 * адаптер. Без `transaction` запись неатомарна — допустимо только для тестов/демо.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  transaction?<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
}

/**
 * Сводка опроса для админ-списка (экран «Опросы», фаза мульти-сущность): ключ, заголовок,
 * номер текущей версии и привязка-датчик (тип сущности + триггеры) из текущей версии.
 * Без вопросов/презентации — это лёгкая проекция для списка/фильтра, деталь грузится отдельно.
 */
export interface SurveySummary {
  surveyKey: string
  title: string
  /** Язык анкеты (один опрос = один язык, решение №3). */
  lang: string
  currentVersionNo: number
  /** Тип сущности-датчика; undefined, если у текущей версии нет invitationPolicy. */
  entityType?: EntityType
  /** id смарт-процесса (только при entityType=spa). */
  spaEntityTypeId?: number
  /** Стадии/статусы-триггеры текущей версии (для фильтра по направлению). */
  triggerStages: string[]
}

/**
 * `member_id` служебного портала-плейсхолдера: под ним копятся данные, пока приложение не связано с
 * Bitrix. Подчёркивания не коллидируют с настоящими member_id.
 *
 * ⚠️ Живёт здесь, а не в `store/bootstrap`, намеренно: константу читают ОБА слоя — бутстрап стора и
 * `bitrix24/portal` (присвоение плейсхолдера, #171). Импорт `bitrix24 → store/bootstrap` разворачивал
 * бы зависимость слоёв (бутстрап тянет `demo/seed` со всем демо-датасетом) и подводил бы к циклу.
 */
export const LOCAL_PORTAL_MEMBER_ID = '__local__'

/** Итог записи ответа: записали или отбросили как повтор по токену приглашения. */
export interface AddResponseResult {
  stored: boolean
}

export interface ResponsePageOptions {
  surveyKey?: string
  limit?: number
  cursor?: string
}

export interface ResponsePage {
  items: ResponseRecord[]
  /** Курсор следующей страницы или undefined, если страниц больше нет. */
  nextCursor?: string
}

/**
 * Контракт хранилища. Методы async, чтобы in-memory реализация и PgStore
 * были взаимозаменяемы без правок вызывающего кода (решение тех-дира).
 */
export interface IStore {
  /**
   * Публикует (компилирует и «замораживает») версию опроса. `versionNo` —
   * положительное целое, монотонно растущее (1, 2, 3…); перезапись номера
   * запрещена (иммутабельность). PgStore гарантирует это через UNIQUE(survey_id, version_no).
   */
  publish(draft: SurveyDraft, versionNo: number): Promise<CompiledVersion>
  /** Версия по номеру или undefined. */
  getVersion(surveyKey: string, versionNo: number): Promise<CompiledVersion | undefined>
  /** Последняя опубликованная версия (её пин кладём в приглашение) или undefined. */
  currentVersion(surveyKey: string): Promise<CompiledVersion | undefined>
  /**
   * survey_key опросов, ТЕКУЩАЯ версия которых триггерится стадией `stageId`
   * (invitationPolicy.triggerStages). Для binding-хендлера ONCRMDEALUPDATE (#17/#22):
   * PgStore — GIN-индекс по денормализованной колонке trigger_stages; MemoryStore — скан.
   * Опросы без invitationPolicy в результат не попадают. Tenant-scoped (PgStore),
   * отсортировано по survey_key. Набор ограничен числом активных опросов портала (без пагинации).
   */
  surveysTriggeredBy(stageId: string): Promise<string[]>
  /**
   * Сводки всех опросов (по их ТЕКУЩЕЙ версии) для админ-списка. Tenant-scoped (PgStore),
   * отсортировано по survey_key. Без пагинации — MVP-ограничение (опросов на портал ожидается
   * немного); при росте добавить keyset. Опросы без опубликованных версий в выборку не попадают.
   */
  listSurveys(): Promise<SurveySummary[]>
  /**
   * Сохраняет завершённую анкету (валидирует запись на границе). Инвариант:
   * `versionNo` записи должен существовать в сторе — в PgStore это FK на survey_version.
   *
   * ⚠️ **Возвращает, ЗАПИСАЛ ли ответ.** `stored: false` — не ошибка: повтор по тому же
   * `invitationToken` отброшен дедупом (частичный UNIQUE в PgStore, множество токенов в памяти).
   *
   * Признак нужен, чтобы `submit` мог гасить приглашение ПОСЛЕ успешной записи, а не до неё
   * ([#170](https://github.com/bx-shef/polls/issues/170)). Раньше метод возвращал `void`, и
   * различить «записали» и «это повтор» было нечем: порядок «погасить → записать» приходилось
   * держать ради честного 409, а он терял ответ клиента навсегда, если запись падала после расхода.
   */
  addResponse(r: ResponseRecord): Promise<AddResponseResult>
  /**
   * Сохранённые ответы; опциональный фильтр по survey_key. Возвращается
   * поверхностная копия (новый массив, те же объекты) — трактуйте записи как
   * read-only, не мутируйте вложенные поля. ВНИМАНИЕ: грузит всё в память — при
   * больших объёмах агрегации должны считаться SQL-запросами на стороне PgStore,
   * а не через listResponses() + in-process. Для постраничной выдачи —
   * `listResponsesPage()` (keyset); tenant-изоляция — в PgStore. SQL-агрегация — #7.
   */
  listResponses(surveyKey?: string): Promise<ResponseRecord[]>

  /**
   * Страница ответов (keyset-пагинация по (submittedAt, id)). Для больших объёмов —
   * вместо `listResponses()`: PgStore толкает `LIMIT` в SQL. Курсор opaque, store-specific.
   */
  listResponsesPage(opts?: ResponsePageOptions): Promise<ResponsePage>

  /**
   * ОДИН ответ по его идентификатору — для страницы просмотра результата (#18).
   *
   * ⚠️ **Метод отдельный, а не «отфильтровать `listResponses`».** Чтение по id идёт на каждое
   * открытие результата менеджером, а `listResponses` грузит в память ВСЕ ответы портала — на
   * работающем портале это тысячи записей ради одной. PgStore берёт строку индексом.
   *
   * ⚠️ **Скоуп портала — на реализации, как и везде.** `responseId` присылает клиент (он приезжает
   * в параметрах кнопки на деле), и без фильтра по `portal_id` менеджер одного заказчика прочитал бы
   * ответ другого, подставив чужой id: ответ несёт свободный текст клиента и снимок сделки. Это тот
   * же инвариант, что у остальных чтений, и нарушается он здесь тише — id угадывается перебором.
   *
   * `undefined` — записи нет ИЛИ она чужого портала. Разница наружу не отдаётся намеренно: «есть, но
   * не ваш» это ответ на вопрос, который спрашивающему задавать не положено.
   */
  getResponse(responseId: string): Promise<ResponseRecord | undefined>

  /**
   * Отвечал ли клиент по этой сделке и этому опросу ПОСЛЕ указанного момента.
   *
   * Нужен правилу «уже приглашали?» (#138): дело в таймлайне закрыто — значит ли это, что клиент
   * ответил, или менеджер просто снял задачу с себя? Отличает только факт ответа.
   *
   * ⚠️ Именно «после момента», а не «вообще». Сделка может пройти триггерную стадию ВТОРОЙ раз, и
   * прошлогодний ответ не должен закрывать новый повод спросить. Момент берётся из той же записи
   * истории стадий, что дала ключ перехода, — поэтому ничего дополнительно хранить не нужно.
   *
   * ⚠️ Это чтение НАШИХ данных (ответы — и есть продукт), а не параллельная бухгалтерия отправок:
   * признак «приглашали» живёт в CRM, здесь спрашивается только «ответили ли».
   */
  hasResponseSince(surveyKey: string, dealId: number, since: Date): Promise<boolean>

  /**
   * Всё, что дашборд показывает по опросу, ОДНИМ обращением к хранилищу (#49).
   *
   * ⚠️ **Метод отдельный, а не «посчитать по `listResponses`».** Дашборд открывают из фрейма CRM, и
   * до этого метода каждое открытие поднимало в память ВСЕ ответы опроса и считало по ним восемь
   * агрегатов синхронно. С мультитенантом это уже не «неоптимально»: один сотрудник одного портала
   * занимает пул и event loop **всем арендаторам**. `PgStore` считает то же самое в SQL.
   *
   * ⚠️ **Подавление малых выборок — ВНУТРИ реализации, а не у вызывающего.** Срезы несут имена
   * клиентов и сотрудников; правило «группа меньше порога не выводится» обязано жить там же, где
   * данные, иначе его можно обойти, позвав порт напрямую. Единственное исключение названо в
   * `CLAUDE.md` §Инварианты: k-анонимность ЯЧЕЕК распределения (`suppressSmallBins`) — дело
   * потребителя, потому что сырое распределение нужно и для расчётов.
   *
   * ⚠️ Ключи вопросов (`npsKey`/`csatKey`/`choiceKey`) приходят СНАРУЖИ, из версии опроса: хранилище
   * не решает, какой вопрос считать метрикой NPS. Ключа нет ⇒ метрики нет (`null`), а не «угадали».
   */
  dashboardAggregates(q: DashboardQuery): Promise<DashboardAggregates>

  /**
   * Health-проба соединения с хранилищем (для `GET /api/health`, #5).
   * Резолвится при живом соединении, реджектится при недоступности БД.
   * MemoryStore — тривиально ок; PgStore выполняет дешёвый `select 1`.
   */
  ping(): Promise<void>
}
