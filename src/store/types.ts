import type { CompiledVersion, ResponseRecord, SurveyDraft } from '../domain/schema'

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
   * Tenant-scoped (PgStore). Отсортирован по survey_key.
   */
  surveysTriggeredBy(stageId: string): Promise<string[]>
  /**
   * Сохраняет завершённую анкету (валидирует запись на границе). Инвариант:
   * `versionNo` записи должен существовать в сторе — в PgStore это FK на survey_version.
   */
  addResponse(r: ResponseRecord): Promise<void>
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
   * Health-проба соединения с хранилищем (для `GET /api/health`, #5).
   * Резолвится при живом соединении, реджектится при недоступности БД.
   * MemoryStore — тривиально ок; PgStore выполняет дешёвый `select 1`.
   */
  ping(): Promise<void>
}
