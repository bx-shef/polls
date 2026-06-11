import { compile } from '../domain/compile'
import { responseRecordSchema, type CompiledVersion, type ResponseRecord, type SurveyDraft } from '../domain/schema'
import { afterKeyset, decodeCursor, encodeCursor, keysetCmp } from './cursor'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type IStore, type ResponsePage, type ResponsePageOptions } from './types'

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
    // Валидация на границе записи: гарантирует ISO-дату и форму контекста/ответов
    // (раньше ResponseRecord был plain interface). Zod strip отбрасывает лишние поля.
    // Инвариант «versionNo существует в сторе» обеспечивает PgStore (FK); здесь не
    // проверяется — демо/тесты добавляют ответы напрямую.
    this._responses.push(responseRecordSchema.parse(r))
  }

  async listResponses(surveyKey?: string): Promise<ResponseRecord[]> {
    const rs = surveyKey == null ? this._responses : this._responses.filter((r) => r.surveyKey === surveyKey)
    // Копия, а не внутренняя ссылка: внешний код не должен мутировать стор.
    return [...rs]
  }

  async listResponsesPage(opts: ResponsePageOptions = {}): Promise<ResponsePage> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const base = opts.surveyKey == null ? this._responses : this._responses.filter((r) => r.surveyKey === opts.surveyKey)
    const sorted = [...base].sort(keysetCmp)
    const after = opts.cursor ? sorted.filter((r) => afterKeyset(r, decodeCursor(opts.cursor!))) : sorted
    const items = after.slice(0, limit)
    const last = items[items.length - 1]
    const nextCursor =
      after.length > limit && last ? encodeCursor({ submittedAt: last.submittedAt, id: last.id }) : undefined
    return { items, nextCursor }
  }
}
