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
  /** Все сохранённые ответы. */
  listResponses(): Promise<ResponseRecord[]>
}
