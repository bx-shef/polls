import type { CompiledVersion, ResponseRecord, SurveyDraft } from '../domain/schema'

/** Размер страницы read-API: дефолт и потолок (защита от тяжёлых выборок). */
export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 500

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
 * Контракт хранилища. Методы async, чтобы in-memory реализация и будущий
 * PgStore были взаимозаменяемы без правок вызывающего кода (решение тех-дира).
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
   * Сохраняет завершённую анкету (валидирует запись на границе). Инвариант:
   * `versionNo` записи должен существовать в сторе — в PgStore это FK на survey_version.
   */
  addResponse(r: ResponseRecord): Promise<void>
  /**
   * Сохранённые ответы; опциональный фильтр по survey_key. Возвращается
   * поверхностная копия (новый массив, те же объекты) — трактуйте записи как
   * read-only, не мутируйте вложенные поля. ВНИМАНИЕ: грузит всё в память — при
   * больших объёмах агрегации должны считаться SQL-запросами на стороне PgStore,
   * а не через listResponses() + in-process. Пагинация/курсор и tenant-фильтр
   * (portalId) — в PgStore (см. ISSUE фазы деплоя: read-API, #7).
   */
  listResponses(surveyKey?: string): Promise<ResponseRecord[]>

  /**
   * Страница ответов (keyset-пагинация по (submittedAt, id)). Для больших объёмов —
   * вместо `listResponses()`: PgStore толкает `LIMIT` в SQL. Курсор opaque, store-specific.
   */
  listResponsesPage(opts?: ResponsePageOptions): Promise<ResponsePage>
}
