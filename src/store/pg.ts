import { compile } from '../domain/compile'
import {
  compiledVersionSchema,
  responseRecordSchema,
  type CompiledVersion,
  type ResponseRecord,
  type SurveyDraft
} from '../domain/schema'
import type { IStore } from './types'

/**
 * Реализация IStore поверх PostgreSQL.
 *
 * Решения:
 * - Драйвер-агностичность: зависит только от минимального контракта `Queryable`,
 *   которому удовлетворяют и `pg.Pool` (прод), и `@electric-sql/pglite` (тесты).
 *   Ядро не тянет `pg` в зависимости — драйвер передаёт слой деплоя (Nuxt/Nitro).
 * - Tenant-изоляция: инстанс PgStore привязан к одному `portalId`; все запросы
 *   фильтруются по нему. Контракт `IStore` при этом не меняется.
 * - Версия хранится целиком в `survey_version.compiled_schema` (JSONB); снимок
 *   CRM-контекста — в `response.context` (JSONB, источник истины для round-trip).
 *
 * TODO (деплой / ISSUE #7): транзакции (BEGIN/COMMIT) на пуле pg; денормализация
 * контекста в индексируемые колонки (`company_id`, …) и `response_product` для
 * SQL-агрегации; пагинация/курсор и подавление малых N в read-API.
 */

/** Минимальный контракт драйвера БД (совместим с pg.Pool и PGlite). */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export interface PgStoreOptions {
  /** Tenant: все операции инстанса ограничены этим порталом (изоляция). */
  portalId: number
  /** Группа опросов; по умолчанию авто-создаваемая «default» группа портала. */
  groupTitle?: string
}

/** Дата из БД (Date или строка) → ISO-8601. `new Date()` принимает оба варианта. */
function toIso(v: unknown): string {
  return new Date(v as string | number | Date).toISOString()
}

/** Postgres `numeric` драйвер отдаёт строкой (точность) — приводим к number|null. */
function toNum(v: unknown): number | null {
  return v == null ? null : Number(v)
}

export class PgStore implements IStore {
  constructor(
    private readonly db: Queryable,
    private readonly opts: PgStoreOptions
  ) {}

  private async ensureGroupId(): Promise<number> {
    const title = this.opts.groupTitle ?? 'default'
    const sel = await this.db.query<{ id: number }>(
      'select id from survey_group where portal_id = $1 and title = $2 limit 1',
      [this.opts.portalId, title]
    )
    if (sel.rows[0]) return sel.rows[0].id
    const ins = await this.db.query<{ id: number }>(
      'insert into survey_group (portal_id, title) values ($1, $2) returning id',
      [this.opts.portalId, title]
    )
    return ins.rows[0]!.id
  }

  private async ensureSurveyId(surveyKey: string, title: string, lang: string): Promise<number> {
    const groupId = await this.ensureGroupId()
    const sel = await this.db.query<{ id: number }>(
      'select id from survey where group_id = $1 and survey_key = $2 limit 1',
      [groupId, surveyKey]
    )
    if (sel.rows[0]) return sel.rows[0].id
    const ins = await this.db.query<{ id: number }>(
      'insert into survey (group_id, survey_key, title, lang) values ($1, $2, $3, $4) returning id',
      [groupId, surveyKey, title, lang]
    )
    return ins.rows[0]!.id
  }

  private async surveyIdByKey(surveyKey: string): Promise<number | undefined> {
    const r = await this.db.query<{ id: number }>(
      `select s.id from survey s
       join survey_group g on g.id = s.group_id
       where g.portal_id = $1 and s.survey_key = $2 limit 1`,
      [this.opts.portalId, surveyKey]
    )
    return r.rows[0]?.id
  }

  async publish(draft: SurveyDraft, versionNo: number): Promise<CompiledVersion> {
    const version = compile(draft, versionNo)
    const surveyId = await this.ensureSurveyId(version.surveyKey, version.title, version.lang)
    const dup = await this.db.query(
      'select 1 from survey_version where survey_id = $1 and version_no = $2',
      [surveyId, versionNo]
    )
    if (dup.rows[0]) {
      throw new Error(`Версия ${versionNo} опроса ${version.surveyKey} уже опубликована`)
    }
    await this.db.query(
      `insert into survey_version (survey_id, version_no, status, compiled_schema, published_at)
       values ($1, $2, 'published', $3, $4)`,
      [surveyId, versionNo, JSON.stringify(version), version.compiledAt]
    )
    await this.db.query(
      `update survey set current_version_id = (
         select id from survey_version where survey_id = $1 order by version_no desc limit 1
       ) where id = $1`,
      [surveyId]
    )
    return version
  }

  async getVersion(surveyKey: string, versionNo: number): Promise<CompiledVersion | undefined> {
    const r = await this.db.query<{ compiled_schema: unknown }>(
      `select sv.compiled_schema from survey_version sv
       join survey s on s.id = sv.survey_id
       join survey_group g on g.id = s.group_id
       where g.portal_id = $1 and s.survey_key = $2 and sv.version_no = $3 limit 1`,
      [this.opts.portalId, surveyKey, versionNo]
    )
    const row = r.rows[0]
    return row ? compiledVersionSchema.parse(row.compiled_schema) : undefined
  }

  async currentVersion(surveyKey: string): Promise<CompiledVersion | undefined> {
    const r = await this.db.query<{ compiled_schema: unknown }>(
      `select sv.compiled_schema from survey_version sv
       join survey s on s.id = sv.survey_id
       join survey_group g on g.id = s.group_id
       where g.portal_id = $1 and s.survey_key = $2
       order by sv.version_no desc limit 1`,
      [this.opts.portalId, surveyKey]
    )
    const row = r.rows[0]
    return row ? compiledVersionSchema.parse(row.compiled_schema) : undefined
  }

  async addResponse(r: ResponseRecord): Promise<void> {
    const rec = responseRecordSchema.parse(r)
    const surveyId = await this.surveyIdByKey(rec.surveyKey)
    if (surveyId == null) throw new Error(`Опрос ${rec.surveyKey} не опубликован`)
    const ver = await this.db.query<{ id: number }>(
      'select id from survey_version where survey_id = $1 and version_no = $2 limit 1',
      [surveyId, rec.versionNo]
    )
    const versionId = ver.rows[0]?.id
    if (versionId == null) {
      throw new Error(`Версия ${rec.versionNo} опроса ${rec.surveyKey} не найдена`)
    }
    const resp = await this.db.query<{ id: number }>(
      `insert into response (portal_id, survey_id, survey_version_id, version_no, context, submitted_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [this.opts.portalId, surveyId, versionId, rec.versionNo, JSON.stringify(rec.context), rec.submittedAt]
    )
    const responseId = resp.rows[0]!.id
    for (let i = 0; i < rec.answers.length; i++) {
      const a = rec.answers[i]!
      await this.db.query(
        `insert into response_answer
           (response_id, question_key, metric, value_choice, value_number, value_text, position)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [responseId, a.questionKey, a.metric, a.valueChoice, a.valueNumber, a.valueText, i]
      )
    }
  }

  async listResponses(surveyKey?: string): Promise<ResponseRecord[]> {
    const where = surveyKey ? 'and s.survey_key = $2' : ''
    const params = surveyKey ? [this.opts.portalId, surveyKey] : [this.opts.portalId]
    const rows = await this.db.query<{
      id: number
      survey_key: string
      version_no: number
      submitted_at: unknown
      context: unknown
    }>(
      `select r.id, s.survey_key, r.version_no, r.submitted_at, r.context
       from response r
       join survey s on s.id = r.survey_id
       where r.portal_id = $1 ${where}
       order by r.submitted_at asc, r.id asc`,
      params
    )
    const out: ResponseRecord[] = []
    for (const row of rows.rows) {
      const ans = await this.db.query<{
        question_key: string
        metric: string
        value_choice: string[] | null
        value_number: string | number | null
        value_text: string | null
      }>(
        `select question_key, metric, value_choice, value_number, value_text
         from response_answer where response_id = $1 order by position asc, id asc`,
        [row.id]
      )
      out.push(
        responseRecordSchema.parse({
          id: String(row.id),
          surveyKey: row.survey_key,
          versionNo: row.version_no,
          submittedAt: toIso(row.submitted_at),
          context: row.context ?? {},
          answers: ans.rows.map((a) => ({
            questionKey: a.question_key,
            metric: a.metric,
            valueChoice: a.value_choice ?? [],
            valueNumber: toNum(a.value_number),
            valueText: a.value_text
          }))
        })
      )
    }
    return out
  }
}
