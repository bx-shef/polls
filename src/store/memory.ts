import { compile } from '../domain/compile'
import type { CompiledVersion, ResponseRecord, SurveyDraft } from '../domain/schema'
import type { IStore } from './types'

/**
 * In-memory реализация {@link IStore} — для локальной проверки итога и тестов.
 * В фазе деплоя рядом появится PgStore с тем же контрактом (см. migrations/).
 */
export class MemoryStore implements IStore {
  private versions: CompiledVersion[] = []
  private _responses: ResponseRecord[] = []

  async publish(draft: SurveyDraft, versionNo: number): Promise<CompiledVersion> {
    if (await this.getVersion(draft.surveyKey, versionNo)) {
      throw new Error(`Версия ${versionNo} опроса ${draft.surveyKey} уже опубликована`)
    }
    const version = compile(draft, versionNo)
    this.versions.push(version)
    return version
  }

  async getVersion(surveyKey: string, versionNo: number): Promise<CompiledVersion | undefined> {
    return this.versions.find((v) => v.surveyKey === surveyKey && v.versionNo === versionNo)
  }

  async currentVersion(surveyKey: string): Promise<CompiledVersion | undefined> {
    // filter() создаёт новый массив, поэтому sort() не мутирует this.versions.
    return this.versions
      .filter((v) => v.surveyKey === surveyKey)
      .sort((a, b) => b.versionNo - a.versionNo)[0]
  }

  async addResponse(r: ResponseRecord): Promise<void> {
    this._responses.push(r)
  }

  async listResponses(): Promise<ResponseRecord[]> {
    return this._responses
  }
}
