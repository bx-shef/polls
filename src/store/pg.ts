import { ANONYMITY_THRESHOLD, meetsAnonymity } from '../domain/aggregate'
import { compile } from '../domain/compile'
import { round1, round2, type CsatSummary, type NpsSummary } from '../domain/metrics'
import {
  compiledVersionSchema,
  responseRecordSchema,
  type CompiledVersion,
  type ResponseRecord,
  type SurveyDraft
} from '../domain/schema'
import { decodeCursor, encodeCursor } from './cursor'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type IStore, type ResponsePage, type ResponsePageOptions } from './types'

/**
 * Реализация IStore поверх PostgreSQL + SQL-агрегация (read-API, #7).
 *
 * Решения:
 * - Драйвер-агностичность: зависит только от контракта `Queryable` (query +
 *   опциональная transaction), которому удовлетворяют и `pg.Pool` (прод, через
 *   адаптер — см. JSDoc Queryable), и `@electric-sql/pglite` (тесты). Ядро не
 *   тянет `pg` в зависимости — драйвер передаёт слой деплоя (Nuxt/Nitro).
 * - Tenant-изоляция: инстанс PgStore привязан к одному `portalId`; все запросы
 *   фильтруются по нему. Контракт `IStore` при этом не меняется.
 * - Версия хранится целиком в `survey_version.compiled_schema` (JSONB). Снимок
 *   CRM-контекста: JSONB `response.context` (источник истины, lossless) +
 *   денормализация в колонки (`company_id`, …) и `response_product` — для
 *   индексов и SQL-агрегации.
 * - Запись (publish/addResponse) выполняется в транзакции, если драйвер её
 *   поддерживает; ensure-методы идемпотентны (INSERT … ON CONFLICT) — нет
 *   TOCTOU-гонки при конкурентных запросах.
 * - SQL-агрегаты (aggregateNps/Csat/Distribution) считают метрики в БД (без
 *   загрузки ответов в память) и ПРИНУДИТЕЛЬНО подавляют малые выборки на
 *   чувствительных срезах; PII (contactId) в агрегатах не участвует.
 *
 * Остаётся (#3/#4/#7): идемпотентность addResponse и связь invitation_id (когда
 * появится invitation-flow), PII-редакция/erasure на HTTP-слое, SQL-вариант npsTrend.
 */

/**
 * Минимальный контракт драйвера БД (совместим с pg.Pool и PGlite).
 * `transaction` опциональна: PGlite даёт её из коробки; для `pg.Pool` используйте
 * фабрику {@link queryableFromPool} — она строит корректный транзакционный
 * адаптер. Без `transaction` запись неатомарна — допустимо только для тестов/демо
 * (в проде включайте `requireTransaction` в PgStoreOptions).
 */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  transaction?<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
}

/** Структурный минимум pg.Pool (ядро не тянет зависимость `pg`). */
export interface PoolLike {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  connect(): Promise<{
    query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
    release(): void
  }>
}

/**
 * Фабрика Queryable из `pg.Pool`: транзакция = выделенный клиент +
 * BEGIN/COMMIT/ROLLBACK/release. Используйте дефолтный уровень изоляции
 * (READ COMMITTED) — ensure-паттерн «ON CONFLICT + SELECT» на него рассчитан.
 */
export function queryableFromPool(pool: PoolLike): Queryable {
  return {
    query: (sql, params) => pool.query(sql, params),
    transaction: async (fn) => {
      const c = await pool.connect()
      let committed = false
      try {
        await c.query('begin')
        const result = await fn({ query: (sql, params) => c.query(sql, params) })
        await c.query('commit')
        committed = true
        return result
      } finally {
        // rollback «тихий»: его сбой (умершее соединение) не маскирует исходную
        // ошибку fn; release возвращает клиента пулу в любом случае.
        if (!committed) await c.query('rollback').catch(() => undefined)
        c.release()
      }
    }
  }
}

export interface PgStoreOptions {
  /** Tenant: все операции инстанса ограничены этим порталом (изоляция). */
  portalId: number
  /** Группа опросов; по умолчанию авто-создаваемая «default» группа портала. */
  groupTitle?: string
  /**
   * Прод-режим: упасть на старте, если драйвер не поддерживает транзакции
   * (страховка от тихой неатомарной записи при «голом» pg.Pool без адаптера).
   */
  requireTransaction?: boolean
}

/**
 * Срез для SQL-агрегации. Поля company/category/responsible/product/deal делают
 * срез «чувствительным»: эффективный порог подавления не может опуститься ниже
 * ANONYMITY_THRESHOLD (анонимность), `minN` может его только поднять.
 * `versionFrom`/`versionTo` чувствительными НЕ считаются (легитимное сравнение
 * версий) — при узких версионных окнах вызывающий сам отвечает за анонимность
 * (передавайте `minN` ≥ ANONYMITY_THRESHOLD).
 */
export interface AggregateFilter {
  surveyKey: string
  questionKey: string
  companyId?: number
  dealCategoryId?: number
  responsibleId?: number
  productId?: number
  dealId?: number
  versionFrom?: number
  versionTo?: number
  /**
   * Порог подавления; null-результат = «данных нет или срез подавлен».
   * Дефолт: 1 на нечувствительных срезах (подавления нет), ANONYMITY_THRESHOLD
   * на чувствительных (опустить ниже нельзя).
   */
  minN?: number
}

/** Дата из БД (Date или строка) → ISO-8601. `new Date()` принимает оба варианта. */
function toIso(v: unknown): string {
  return new Date(v as string | number | Date).toISOString()
}

/** Postgres `numeric` драйвер отдаёт строкой (точность) — приводим к number|null. */
function toNum(v: unknown): number | null {
  return v == null ? null : Number(v)
}

type ResponseRow = {
  id: string | number // pg отдаёт bigint строкой; pglite — числом
  survey_key: string
  version_no: number
  submitted_at: unknown
  context: unknown
}

type AnswerRow = {
  response_id: string | number
  question_key: string
  metric: string
  value_choice: string[] | null
  value_number: string | number | null
  value_text: string | null
}

const SELECT_RESPONSE = `select r.id, s.survey_key, r.version_no, r.submitted_at, r.context
   from response r join survey s on s.id = r.survey_id`

const AGG_FROM = `from response_answer ra
   join response r on r.id = ra.response_id
   join survey s on s.id = r.survey_id`

export class PgStore implements IStore {
  constructor(
    private readonly db: Queryable,
    private readonly opts: PgStoreOptions
  ) {
    if (opts.requireTransaction && !db.transaction) {
      throw new Error('PgStore: драйвер без transaction — оберните pg.Pool через queryableFromPool()')
    }
  }

  /** Транзакция, если драйвер умеет; иначе — последовательные запросы (см. Queryable). */
  private inTx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction ? this.db.transaction(fn) : fn(this.db)
  }

  /**
   * Идемпотентно (ON CONFLICT): параллельный вызов не падает на гонке SELECT→INSERT.
   * Системная группа — без владельца; предикат соответствует частичному индексу
   * uq_survey_group_default (пользовательские группы могут совпадать по названию).
   */
  private async ensureGroupId(db: Queryable): Promise<number> {
    const title = this.opts.groupTitle ?? 'default'
    const ins = await db.query<{ id: number }>(
      `insert into survey_group (portal_id, title) values ($1, $2)
       on conflict (portal_id, title) where owner_user_id is null do nothing returning id`,
      [this.opts.portalId, title]
    )
    if (ins.rows[0]) return ins.rows[0].id
    const sel = await db.query<{ id: number }>(
      'select id from survey_group where portal_id = $1 and title = $2 and owner_user_id is null limit 1',
      [this.opts.portalId, title]
    )
    return sel.rows[0]!.id
  }

  private async ensureSurveyId(db: Queryable, surveyKey: string, title: string, lang: string): Promise<number> {
    const groupId = await this.ensureGroupId(db)
    const ins = await db.query<{ id: number }>(
      `insert into survey (group_id, survey_key, title, lang) values ($1, $2, $3, $4)
       on conflict (group_id, survey_key) do nothing returning id`,
      [groupId, surveyKey, title, lang]
    )
    if (ins.rows[0]) return ins.rows[0].id
    const sel = await db.query<{ id: number }>(
      'select id from survey where group_id = $1 and survey_key = $2 limit 1',
      [groupId, surveyKey]
    )
    return sel.rows[0]!.id
  }

  private async surveyIdByKey(db: Queryable, surveyKey: string): Promise<number | undefined> {
    const r = await db.query<{ id: number }>(
      `select s.id from survey s
       join survey_group g on g.id = s.group_id
       where g.portal_id = $1 and s.survey_key = $2 limit 1`,
      [this.opts.portalId, surveyKey]
    )
    return r.rows[0]?.id
  }

  async publish(draft: SurveyDraft, versionNo: number): Promise<CompiledVersion> {
    const version = compile(draft, versionNo)
    return this.inTx(async (db) => {
      const surveyId = await this.ensureSurveyId(db, version.surveyKey, version.title, version.lang)
      const dup = await db.query(
        'select 1 from survey_version where survey_id = $1 and version_no = $2',
        [surveyId, versionNo]
      )
      if (dup.rows[0]) {
        throw new Error(`Версия ${versionNo} опроса ${version.surveyKey} уже опубликована`)
      }
      await db.query(
        `insert into survey_version (survey_id, version_no, status, compiled_schema, published_at)
         values ($1, $2, 'published', $3, $4)`,
        [surveyId, versionNo, JSON.stringify(version), version.compiledAt]
      )
      // current = max(version_no), а не «последняя вставленная»: публикация задним
      // числом (v1 после v2) не должна откатывать пин текущей версии.
      await db.query(
        `update survey set current_version_id = (
           select id from survey_version where survey_id = $1 order by version_no desc limit 1
         ) where id = $1`,
        [surveyId]
      )
      return version
    })
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
    await this.inTx(async (db) => {
      const surveyId = await this.surveyIdByKey(db, rec.surveyKey)
      if (surveyId == null) throw new Error(`Опрос ${rec.surveyKey} не опубликован`)
      const ver = await db.query<{ id: number }>(
        'select id from survey_version where survey_id = $1 and version_no = $2 limit 1',
        [surveyId, rec.versionNo]
      )
      const versionId = ver.rows[0]?.id
      if (versionId == null) {
        throw new Error(`Версия ${rec.versionNo} опроса ${rec.surveyKey} не найдена`)
      }
      const c = rec.context
      const resp = await db.query<{ id: number }>(
        `insert into response
           (portal_id, survey_id, survey_version_id, version_no, deal_id, deal_category_id,
            company_id, contact_id, responsible_id, context, submitted_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [
          this.opts.portalId, surveyId, versionId, rec.versionNo,
          c.dealId ?? null, c.dealCategoryId ?? null, c.companyId ?? null,
          c.contactId ?? null, c.responsibleId ?? null, JSON.stringify(c), rec.submittedAt
        ]
      )
      const responseId = resp.rows[0]!.id

      if (rec.answers.length > 0) {
        // Один multi-VALUES INSERT вместо запроса на каждый ответ (анкета ≤ 200 вопросов).
        const values: string[] = []
        const params: unknown[] = []
        rec.answers.forEach((a, i) => {
          const o = params.length
          values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`)
          params.push(responseId, a.questionKey, a.metric, a.valueChoice, a.valueNumber, a.valueText, i)
        })
        await db.query(
          `insert into response_answer
             (response_id, question_key, metric, value_choice, value_number, value_text, position)
           values ${values.join(', ')}`,
          params
        )
      }

      const products = c.products ?? []
      if (products.length > 0) {
        const values: string[] = []
        const params: unknown[] = []
        for (const p of products) {
          const o = params.length
          values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`)
          params.push(responseId, p.productId, p.productName ?? null, p.serviceTag ?? null)
        }
        await db.query(
          `insert into response_product (response_id, product_id, product_name, service_tag)
           values ${values.join(', ')} on conflict (response_id, product_id) do nothing`,
          params
        )
      }
    })
  }

  /** Догружает ответы одним запросом (`= ANY`), без N+1 по строкам страницы. */
  private async hydrate(rows: ResponseRow[]): Promise<ResponseRecord[]> {
    if (rows.length === 0) return []
    const ids = rows.map((r) => String(r.id))
    // join по porталу — защитный (ids уже tenant-фильтрованы выше): свойство
    // изоляции переживёт будущий рефакторинг с иным источником ids.
    const ans = await this.db.query<AnswerRow>(
      `select ra.response_id, ra.question_key, ra.metric, ra.value_choice, ra.value_number, ra.value_text
       from response_answer ra
       join response r on r.id = ra.response_id and r.portal_id = $2
       where ra.response_id = any($1::bigint[])
       order by ra.position asc, ra.id asc`,
      [ids, this.opts.portalId]
    )
    const byResponse = new Map<string, AnswerRow[]>()
    for (const a of ans.rows) {
      const key = String(a.response_id)
      const arr = byResponse.get(key)
      if (arr) arr.push(a)
      else byResponse.set(key, [a])
    }
    return rows.map((row) =>
      responseRecordSchema.parse({
        id: String(row.id),
        surveyKey: row.survey_key,
        versionNo: row.version_no,
        submittedAt: toIso(row.submitted_at),
        context: row.context ?? {},
        answers: (byResponse.get(String(row.id)) ?? []).map((a) => ({
          questionKey: a.question_key,
          metric: a.metric,
          valueChoice: a.value_choice ?? [],
          valueNumber: toNum(a.value_number),
          valueText: a.value_text
        }))
      })
    )
  }

  async listResponses(surveyKey?: string): Promise<ResponseRecord[]> {
    const where = surveyKey ? 'and s.survey_key = $2' : ''
    const params = surveyKey ? [this.opts.portalId, surveyKey] : [this.opts.portalId]
    const rows = await this.db.query<ResponseRow>(
      `${SELECT_RESPONSE} where r.portal_id = $1 ${where} order by r.submitted_at asc, r.id asc`,
      params
    )
    return this.hydrate(rows.rows)
  }

  async listResponsesPage(opts: ResponsePageOptions = {}): Promise<ResponsePage> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const conds = ['r.portal_id = $1']
    const params: unknown[] = [this.opts.portalId]
    if (opts.surveyKey != null) {
      params.push(opts.surveyKey)
      conds.push(`s.survey_key = $${params.length}`)
    }
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor)
      params.push(c.submittedAt, c.id)
      conds.push(`(r.submitted_at, r.id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`)
    }
    params.push(limit + 1)
    const rows = await this.db.query<ResponseRow>(
      `${SELECT_RESPONSE} where ${conds.join(' and ')} order by r.submitted_at asc, r.id asc limit $${params.length}`,
      params
    )
    const slice = rows.rows.slice(0, limit)
    const items = await this.hydrate(slice)
    const last = slice[slice.length - 1]
    const nextCursor =
      rows.rows.length > limit && last
        ? encodeCursor({ submittedAt: toIso(last.submitted_at), id: String(last.id) })
        : undefined
    return { items, nextCursor }
  }

  // ── SQL-агрегация (read-API #7): метрики считает БД, ответы в память не грузятся ──

  /** WHERE среза + эффективный порог подавления (см. AggregateFilter). */
  private slice(f: AggregateFilter): { where: string; params: unknown[]; minN: number } {
    const conds = ['r.portal_id = $1', 's.survey_key = $2', 'ra.question_key = $3']
    const params: unknown[] = [this.opts.portalId, f.surveyKey, f.questionKey]
    // Инвариант: шаблон содержит РОВНО один `?` (replace заменяет только первое вхождение).
    const add = (sql: string, v: unknown): void => {
      params.push(v)
      conds.push(sql.replace('?', `$${params.length}`))
    }
    if (f.companyId != null) add('r.company_id = ?', f.companyId)
    if (f.dealCategoryId != null) add('r.deal_category_id = ?', f.dealCategoryId)
    if (f.responsibleId != null) add('r.responsible_id = ?', f.responsibleId)
    if (f.productId != null) {
      add('exists (select 1 from response_product rp where rp.response_id = r.id and rp.product_id = ?)', f.productId)
    }
    if (f.dealId != null) add('r.deal_id = ?', f.dealId)
    if (f.versionFrom != null) add('r.version_no >= ?', f.versionFrom)
    if (f.versionTo != null) add('r.version_no <= ?', f.versionTo)
    const sensitive =
      f.companyId != null || f.dealCategoryId != null || f.responsibleId != null ||
      f.productId != null || f.dealId != null
    const minN = sensitive ? Math.max(f.minN ?? ANONYMITY_THRESHOLD, ANONYMITY_THRESHOLD) : (f.minN ?? 1)
    return { where: conds.join(' and '), params, minN }
  }

  /**
   * NPS по срезу (SQL). Границы как в domain/metrics: промоутеры ≥9, детракторы ≤6,
   * пассивы — остальное. `null` — данных нет или срез подавлен (n < порога).
   */
  async aggregateNps(f: AggregateFilter): Promise<NpsSummary | null> {
    const { where, params, minN } = this.slice(f)
    const r = await this.db.query<{ n: number; promoters: number; detractors: number }>(
      `select count(*)::int as n,
              count(*) filter (where ra.value_number >= 9)::int as promoters,
              count(*) filter (where ra.value_number <= 6)::int as detractors
       ${AGG_FROM}
       where ${where} and ra.value_number is not null`,
      params
    )
    const row = r.rows[0]!
    if (!meetsAnonymity(row.n, minN)) return null
    const passives = row.n - row.promoters - row.detractors
    return {
      n: row.n,
      promoters: row.promoters,
      passives,
      detractors: row.detractors,
      nps: round1(((row.promoters - row.detractors) / row.n) * 100)
    }
  }

  /** CSAT по срезу (SQL): среднее + топ-бокс (по умолчанию ≥4). `null` — нет данных/подавлено. */
  async aggregateCsat(f: AggregateFilter, opts: { topBoxMin?: number } = {}): Promise<CsatSummary | null> {
    const { where, params, minN } = this.slice(f)
    params.push(opts.topBoxMin ?? 4)
    const r = await this.db.query<{ n: number; mean: string | number | null; top: number }>(
      `select count(*)::int as n,
              avg(ra.value_number) as mean,
              count(*) filter (where ra.value_number >= $${params.length})::int as top
       ${AGG_FROM}
       where ${where} and ra.value_number is not null`,
      params
    )
    const row = r.rows[0]!
    if (!meetsAnonymity(row.n, minN)) return null
    // после проверки порога n ≥ 1 → avg по непустой выборке не бывает NULL
    return { n: row.n, mean: round2(Number(row.mean)), topBoxPct: round1((row.top / row.n) * 100) }
  }

  /**
   * Распределение option_key по срезу (SQL, unnest). `null` — нет данных/подавлено.
   * Порог (n ответов) и распределение считаются ОДНИМ statement'ом — один снапшот,
   * без гонки между проверкой подавления и выборкой при конкурентной записи.
   */
  async aggregateDistribution(f: AggregateFilter): Promise<Record<string, number> | null> {
    const { where, params, minN } = this.slice(f)
    const r = await this.db.query<{ n: number; k: string; c: number }>(
      `with src as (
         select ra.value_choice ${AGG_FROM}
         where ${where} and cardinality(ra.value_choice) > 0
       )
       select (select count(*)::int from src) as n, t.k, count(*)::int as c
       from (select unnest(value_choice) as k from src) t
       group by t.k`,
      params
    )
    const n = r.rows[0]?.n ?? 0
    if (!meetsAnonymity(n, minN)) return null
    const out: Record<string, number> = {}
    for (const row of r.rows) out[row.k] = row.c
    return out
  }
}
