import type { CompiledVersion, ResponseRecord, SurveyDraft } from '../domain/schema'

/**
 * Контракт хранилища. Методы async, чтобы in-memory реализация и будущий
 * PgStore были взаимозаменяемы без правок вызывающего кода (решение тех-дира).
 */
export interface IStore {
  /** Публикует (компилирует и «замораживает») версию опроса. */
  publish(draft: SurveyDraft, versionNo: number): Promise<CompiledVersion>
  /** Версия по номеру или undefined. */
  getVersion(surveyKey: string, versionNo: number): Promise<CompiledVersion | undefined>
  /** Последняя опубликованная версия (её пин кладём в приглашение) или undefined. */
  currentVersion(surveyKey: string): Promise<CompiledVersion | undefined>
  /** Сохраняет завершённую анкету. */
  addResponse(r: ResponseRecord): Promise<void>
  /**
   * Сохранённые ответы; опциональный фильтр по survey_key. Возвращается копия,
   * не внутренняя ссылка. Полноценная пагинация/курсор и tenant-фильтр (portalId)
   * — в PgStore (см. ISSUE фазы деплоя: read-API).
   */
  listResponses(surveyKey?: string): Promise<ResponseRecord[]>
}
