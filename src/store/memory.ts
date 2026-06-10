import { compile } from '../domain/compile'
import type { CompiledVersion, ResponseRecord, SurveyDraft } from '../domain/schema'

/**
 * In-memory хранилище — для локальной проверки итога и тестов.
 * В фазе деплоя рядом появится PgStore с той же поверхностью (см. migrations/).
 */
export class MemoryStore {
  private versions: CompiledVersion[] = []
  private _responses: ResponseRecord[] = []

  /** Публикует версию (компилирует черновик и «замораживает»). */
  publish(draft: SurveyDraft, versionNo: number): CompiledVersion {
    if (this.getVersion(draft.surveyKey, versionNo)) {
      throw new Error(`Версия ${versionNo} опроса ${draft.surveyKey} уже опубликована`)
    }
    const version = compile(draft, versionNo)
    this.versions.push(version)
    return version
  }

  getVersion(surveyKey: string, versionNo: number): CompiledVersion | undefined {
    return this.versions.find((v) => v.surveyKey === surveyKey && v.versionNo === versionNo)
  }

  /** Текущая (последняя) опубликованная версия — её пин кладём в приглашение. */
  currentVersion(surveyKey: string): CompiledVersion | undefined {
    return this.versions
      .filter((v) => v.surveyKey === surveyKey)
      .sort((a, b) => b.versionNo - a.versionNo)[0]
  }

  addResponse(r: ResponseRecord): void {
    this._responses.push(r)
  }

  get responses(): ResponseRecord[] {
    return this._responses
  }
}
