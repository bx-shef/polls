import type { CompiledVersion, EntityType, ResponseRecord, SurveyDraft } from '../domain/schema'

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
   * Health-проба соединения с хранилищем (для `GET /api/health`, #5).
   * Резолвится при живом соединении, реджектится при недоступности БД.
   * MemoryStore — тривиально ок; PgStore выполняет дешёвый `select 1`.
   */
  ping(): Promise<void>
}
