import {
  ANONYMITY_THRESHOLD, finishBreakdown, meetsAnonymity,
  type BreakdownRow, type RawGroup, type TrendPoint
} from '../domain/aggregate'
import { compile } from '../domain/compile'
import { round1, round2, CSAT_TOP_BOX_MIN, type CsatSummary, type NpsSummary } from '../domain/metrics'
import {
  compiledVersionSchema,
  invitationPolicySchema,
  responseRecordSchema,
  type CompiledVersion,
  type ResponseRecord,
  type SurveyDraft
} from '../domain/schema'
import { decodeCursor, encodeCursor } from './cursor'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type AddResponseResult,
  type IStore,
  type Queryable,
  type ResponsePage,
  type ResponsePageOptions,
  type SurveySummary,
  type DashboardAggregates,
  type DashboardQuery
} from './types'
// Re-export для обратной совместимости: исторически Queryable жил здесь.
export type { Queryable } from './types'

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
 *   загрузки ответов в память) и ПРИНУДИТЕЛЬНО подавляют малые выборки по
 *   ОБЩЕМУ N среза; PII (contactId) в агрегатах не участвует.
 *   ⚠️ Ячейки `aggregateDistribution` отдаёт СЫРЫМИ: k-анонимность по ячейкам
 *   живёт в `suppressSmallBins` (src/domain/aggregate.ts) и зовётся потребителем (#49).
 *   ⚠️ Прод-кода, зовущего эти четыре метода, СЕГОДНЯ НЕТ: дашборд по-прежнему
 *   считает через `listResponses` + domain/aggregate. Это остаток #49, а не
 *   мёртвый код «на всякий случай» — но пока он не подключён, он и не проверен
 *   ничем, кроме `test/pg.test.ts`.
 *
 * Идемпотентность addResponse — durable по invitation_token (частичный UNIQUE,
 * миграция 0003): повтор приглашения на любом инстансе → ON CONFLICT DO NOTHING (#3/#4).
 * SQL-вариант npsTrend — aggregateNpsTrend (#10). Тех-долг: сейчас якорь идемпотентности —
 * сам токен в колонке `invitation_token`; когда invitation-flow получит общий стор (#4) и
 * приглашения будут жить в таблице `invitation`, ключ дедупа переключится на FK
 * `response.invitation_id` (отдельная будущая миграция; 0004 уже занята portal-lifecycle) — токен как credential в response
 * больше храниться не будет. PII-редакция на HTTP-слое — нет публичного read-ответов,
 * вынесено в ISSUE #31 (там же требование strip'ать invitationToken из проекции).
 */

/** Структурный минимум pg.Pool (ядро не тянет зависимость `pg`). */
export interface PoolLike {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  connect(): Promise<{
    query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
    // `destroy=true` (совместимо с pg `PoolClient.release(err?: boolean)`) уничтожает клиента вместо
    // возврата в пул — нужно, когда соединение мертво (провалился rollback).
    release(destroy?: boolean): void
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
      let rollbackFailed = false
      try {
        await c.query('begin')
        const result = await fn({ query: (sql, params) => c.query(sql, params) })
        await c.query('commit')
        committed = true
        return result
      } finally {
        // rollback «тихий»: его сбой (умершее соединение) не маскирует исходную ошибку fn.
        if (!committed) await c.query('rollback').catch(() => { rollbackFailed = true })
        // Провал rollback ⇒ соединение вероятно мертво: УНИЧТОЖАЕМ клиента (release(true)), иначе
        // следующий взявший его из пула запрос упадёт на мёртвом сокете. Иначе — обычный возврат в пул.
        c.release(rollbackFailed)
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

  /** Health-проба (#5): дешёвый round-trip к БД; реджект → соединение мертво. */
  async ping(): Promise<void> {
    await this.db.query('select 1')
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
        `insert into survey_version (survey_id, version_no, status, compiled_schema, trigger_stages, published_at)
         values ($1, $2, 'published', $3, $4, $5)`,
        [surveyId, versionNo, JSON.stringify(version), version.invitationPolicy?.triggerStages ?? [], version.compiledAt]
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
    // «Текущая» = версия из survey.current_version_id (его проставляет publish = max
    // опубликованного version_no). Тот же указатель использует surveysTriggeredBy —
    // единое определение «текущей версии», не зависящее от черновиков в таблице.
    const r = await this.db.query<{ compiled_schema: unknown }>(
      `select sv.compiled_schema from survey s
       join survey_group g on g.id = s.group_id
       join survey_version sv on sv.id = s.current_version_id
       where g.portal_id = $1 and s.survey_key = $2`,
      [this.opts.portalId, surveyKey]
    )
    const row = r.rows[0]
    return row ? compiledVersionSchema.parse(row.compiled_schema) : undefined
  }

  async surveysTriggeredBy(stageId: string): Promise<string[]> {
    const r = await this.db.query<{ survey_key: string }>(
      `select s.survey_key from survey s
       join survey_group g on g.id = s.group_id
       join survey_version sv on sv.id = s.current_version_id
       where g.portal_id = $1 and sv.trigger_stages @> array[$2]::text[]
       order by s.survey_key`,
      [this.opts.portalId, stageId]
    )
    return r.rows.map((row) => row.survey_key)
  }

  async listSurveys(): Promise<SurveySummary[]> {
    // Лёгкая проекция: тащим из JSONB только нужные скаляры (не весь compiled_schema со
    // всеми вопросами — `SurveySummary` их не содержит), а triggerStages берём из
    // денормализованной колонки (тот же источник, что GIN). Привязку-датчик
    // (entityType/spaEntityTypeId) парсим точечно из поддерева invitation_policy.
    const r = await this.db.query<{
      survey_key: string
      title: string
      lang: string
      version_no: number
      invitation_policy: unknown
      trigger_stages: string[] | null
    }>(
      `select
         sv.compiled_schema->>'surveyKey' as survey_key,
         sv.compiled_schema->>'title' as title,
         sv.compiled_schema->>'lang' as lang,
         (sv.compiled_schema->>'versionNo')::int as version_no,
         sv.compiled_schema->'invitationPolicy' as invitation_policy,
         sv.trigger_stages as trigger_stages
       from survey s
       join survey_group g on g.id = s.group_id
       join survey_version sv on sv.id = s.current_version_id
       where g.portal_id = $1
       order by s.survey_key`,
      [this.opts.portalId]
    )
    return r.rows.map((row) => {
      // invitation_policy может быть null (опрос без политики) — парсим только при наличии.
      const policy = row.invitation_policy != null ? invitationPolicySchema.parse(row.invitation_policy) : undefined
      return {
        surveyKey: row.survey_key,
        title: row.title,
        lang: row.lang,
        currentVersionNo: row.version_no,
        entityType: policy?.entityType,
        spaEntityTypeId: policy?.spaEntityTypeId,
        triggerStages: row.trigger_stages ?? []
      }
    })
  }

  async addResponse(r: ResponseRecord): Promise<AddResponseResult> {
    const rec = responseRecordSchema.parse(r)
    return this.inTx(async (db): Promise<AddResponseResult> => {
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
      // ⚠️ SECURITY-RELEVANT: на `invitation_token` в этой строке держится ОДНОРАЗОВОСТЬ ссылки
      // (#170) — `invitation.used_at` после того PR стал бухгалтерией, а не барьером. Значит чистка
      // ПДн (#31/#10) и план «перевести дедуп на FK `invitation_id`» обязаны сначала восстановить
      // барьер: иначе удаление строки/обнуление токена молча вернёт возможность ответить по ссылке
      // второй раз и переписать оценку. Подробности — issue #181.
      // ON CONFLICT по частичному uq_response_invitation_token (см. миграцию 0003):
      // повтор того же invitation_token (даже с другого инстанса) → DO NOTHING, строка
      // не вставляется и `rows` пуст → идемпотентный no-op ниже. Токен NULL
      // (публичный ответ без приглашения) под предикат индекса не подпадает — вставка идёт.
      const resp = await db.query<{ id: number }>(
        `insert into response
           (portal_id, survey_id, survey_version_id, version_no, deal_id, deal_category_id,
            company_id, contact_id, responsible_id, context, submitted_at, invitation_token)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (portal_id, invitation_token) where invitation_token is not null do nothing
         returning id`,
        [
          this.opts.portalId, surveyId, versionId, rec.versionNo,
          c.dealId ?? null, c.dealCategoryId ?? null, c.companyId ?? null,
          c.contactId ?? null, c.responsibleId ?? null, JSON.stringify(c), rec.submittedAt,
          rec.invitationToken ?? null
        ]
      )
      const responseId = resp.rows[0]?.id
      // Дубль по invitation_token: ответ уже записан (этим или соседним инстансом) —
      // выходим, не плодя ответы/товары. Это и есть durable single-use (#3/#4). Наружу отдаём
      // `stored: false`: вызывающий по нему отвечает честным 409, а не молча принимает повтор.
      // return из колбэка inTx завершает транзакцию COMMIT'ом (не throw) — частичной
      // записи нет: response не вставлен, children тем более.
      if (responseId == null) return { stored: false }

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
      return { stored: true }
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

  async getResponse(responseId: string): Promise<ResponseRecord | undefined> {
    // ⚠️ `portal_id` в WHERE — несущее, а не «как везде за компанию»: `responseId` приезжает из
    // параметров кнопки, то есть из недоверенной части запроса. Без фильтра менеджер одного портала
    // прочитал бы ответ другого простым перебором id — а ответ несёт свободный текст клиента.
    // ⚠️ Форму отсекаем ДО базы. Сперва здесь стояло `r.id::text = $2` — оно не падало на нечисловом
    // значении, но выключало индекс по первичному ключу: план шёл по портальному индексу и вычислял
    // `id::text` на КАЖДОЙ строке портала. На портале с десятками тысяч ответов это скан на каждое
    // открытие результата, то есть дешёвый рычаг нагрузки для любого сотрудника. `id` в PgStore —
    // `bigint`, и нечисловая строка нашей записью быть не может по построению.
    if (!/^\d{1,19}$/.test(responseId)) return undefined
    const rows = await this.db.query<ResponseRow>(
      `${SELECT_RESPONSE} where r.portal_id = $1 and r.id = $2::bigint limit 1`,
      [this.opts.portalId, responseId]
    )
    return (await this.hydrate(rows.rows))[0]
  }

  async hasResponseSince(surveyKey: string, dealId: number, since: Date): Promise<boolean> {
    // `limit 1` и `exists`-семантика: вопрос булев, тянуть строки незачем. Фильтр по `portal_id` —
    // как везде: ответ чужого портала не должен закрывать наш повод спросить (tenant-изоляция).
    // `deal_id` — денормализованная колонка: в JSONB-`context` лезть не нужно. ⚠️ Отдельного индекса
    // по ней НЕТ (проверено EXPLAIN'ом: план идёт `idx_response_portal_survey`, а `deal_id` и
    // `submitted_at` уходят в Filter). Пока это дёшево — путь редкий: вопрос задаётся, только когда
    // по маркеру НАШЛОСЬ закрытое дело. Станет горячим — заводить `(portal_id, deal_id, submitted_at)`.
    const r = await this.db.query<{ one: number }>(
      `select 1 as one
         from response r
         join survey s on s.id = r.survey_id
        where r.portal_id = $1 and s.survey_key = $2 and r.deal_id = $3 and r.submitted_at >= $4
        limit 1`,
      [this.opts.portalId, surveyKey, dealId, since]
    )
    return r.rows.length > 0
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
   * Агрегаты дашборда целиком — В БАЗЕ, без загрузки ответов в память (#49).
   *
   * ⚠️ Считает ровно то же, что чистая `dashboardFromResponses` над массивом; тест паритета
   * (`test/dashboard-aggregates.test.ts`) прогоняет обе реализации по одним данным и сравнивает
   * результат ЦЕЛИКОМ. Расхождение здесь — не «немного другие цифры»: дашборд читают, чтобы
   * принимать решения по сотрудникам и клиентам.
   *
   * ⚠️ Подавление групп, отбор строк и сортировка — ОБЩИЙ код (`finishBreakdown`). SQL отвечает
   * только за ГРУППИРОВКУ; иначе порог «на единицу строже» в одной из реализаций жил бы до первого
   * большого портала.
   */
  async dashboardAggregates(q: DashboardQuery): Promise<DashboardAggregates> {
    // ⚠️ Шаг 1 — ОДИН дешёвый запрос: размер выборки и список версий. Всё остальное делается только
    // если оно вообще понадобится (см. гейт ниже) — свежий опрос стоит одного запроса, а не девяти.
    const counts = await this.db.query<{ n: number; version_no: number }>(
      `select count(*)::int as n, r.version_no
       from response r join survey s on s.id = r.survey_id
       where r.portal_id = $1 and s.survey_key = $2
       group by r.version_no
       order by r.version_no asc`,
      [this.opts.portalId, q.surveyKey]
    )
    const versions = counts.rows.map((row) => row.version_no)
    // Несуществующую версию игнорируем ЗДЕСЬ: список версий известен только отсюда, и вид,
    // проверявший его у себя, был вынужден ходить в хранилище второй раз.
    const version = q.versionNo != null && versions.includes(q.versionNo) ? q.versionNo : null
    const n = version != null
      ? (counts.rows.find((row) => row.version_no === version)?.n ?? 0)
      : counts.rows.reduce((a, row) => a + row.n, 0)

    // ⚠️ Гейт по общему N — в слое чтения. Разбор — в `dashboardFromResponses`; здесь он ещё и
    // отсекает восемь запросов на состоянии, в котором дашборд открывают чаще всего.
    if (!meetsAnonymity(n)) {
      return {
        n, versions, version,
        nps: null, csat: null, distribution: null, trend: [],
        services: [], directions: [], responsibles: [], clients: []
      }
    }

    const base = { surveyKey: q.surveyKey, versionFrom: version ?? undefined, versionTo: version ?? undefined }

    // ⚠️ Запросы идут ДВУМЯ волнами по четыре, а не восемью разом. Пул `pg` по умолчанию держит 10
    // соединений, и восемь параллельных запросов означали бы, что ОДНО открытие дашборда занимает
    // восемь из десяти: два одновременных дашборда клали бы в очередь запись ответов, выписку
    // приглашений и health-пробу. Это ровно тот кросс-тенантный эффект, ради устранения которого
    // #49 и открыт, только переехавший из event loop в пул.
    const [nps, csat, distribution, trend] = await Promise.all([
      q.npsKey ? this.aggregateNps({ ...base, questionKey: q.npsKey }) : Promise.resolve(null),
      q.csatKey ? this.aggregateCsat({ ...base, questionKey: q.csatKey }) : Promise.resolve(null),
      q.choiceKey ? this.aggregateDistribution({ ...base, questionKey: q.choiceKey }) : Promise.resolve(null),
      // Порог точки тренда — тот же ANONYMITY_THRESHOLD: месяц с малой выборкой не показываем.
      q.npsKey
        ? this.aggregateNpsTrend({ ...base, questionKey: q.npsKey, minN: ANONYMITY_THRESHOLD }, 'month')
        : Promise.resolve([])
    ])
    const [services, directions, responsibles, clients] = await Promise.all([
      this.breakdown('product', q, version),
      this.breakdown('dealCategory', q, version),
      this.breakdown('responsible', q, version),
      this.breakdown('company', q, version)
    ])
    return { n, versions, version, nps, csat, distribution, trend, services, directions, responsibles, clients }
  }

  /**
   * Одна группировка среза в SQL. Четыре измерения отличаются ТОЛЬКО выражением ключа, имени и
   * источником строк — поэтому запрос один, а не четыре похожих.
   *
   * ⚠️ Имя группы фиксируется ПЕРВЫМ вхождением ключа в порядке `(submitted_at, id)` — том же, в
   * котором ответы отдаёт `listResponses`. Совпадение порядка несущее: переименовали услугу в CRM —
   * обе реализации обязаны выбрать одно и то же имя, иначе на дашборде оно «прыгает» между
   * инсталляциями с базой и без.
   *
   * ⚠️ `count(distinct …)`, а не `count(*)`: соединение с ответами на вопросы размножает строку
   * ответа по числу его ответов, и без `distinct` группа из пяти человек показала бы двадцать.
   */
  private async breakdown(
    dim: 'product' | 'dealCategory' | 'responsible' | 'company',
    q: DashboardQuery,
    version: number | null
  ): Promise<BreakdownRow[]> {
    // Ключ и имя измерения. Имена денормализованы в снимке CRM (`context`), у товаров — своя таблица.
    const dims = {
      product: {
        join: 'join response_product rp on rp.response_id = r.id',
        key: 'rp.product_id',
        name: "coalesce(rp.product_name, '#' || rp.product_id)"
      },
      dealCategory: {
        join: '',
        key: 'r.deal_category_id',
        name: "coalesce(r.context->>'dealCategoryName', '#' || r.deal_category_id)"
      },
      responsible: {
        join: '',
        key: 'r.responsible_id',
        name: "coalesce(r.context->>'responsibleName', '#' || r.responsible_id)"
      },
      company: {
        join: '',
        key: 'r.company_id',
        name: "coalesce(r.context->>'companyName', '#' || r.company_id)"
      }
    }[dim]

    const params: unknown[] = [this.opts.portalId, q.surveyKey, version, q.npsKey ?? null, q.csatKey ?? null]
    const rows = await this.db.query<{
      name: string
      n: number
      nps_n: number
      nps_prom: number
      nps_detr: number
      csat_n: number
      csat_sum: string | number | null
    }>(
      `with grp as (
         select ${dims.key} as gkey, r.id as rid, r.submitted_at as at, ${dims.name} as gname
         from response r
         join survey s on s.id = r.survey_id
         ${dims.join}
         where r.portal_id = $1 and s.survey_key = $2
           and ($3::int is null or r.version_no = $3)
           and ${dims.key} is not null
       )
       select (array_agg(g.gname order by g.at asc, g.rid asc))[1] as name,
              count(distinct g.rid)::int as n,
              -- Выборки метрик считаются как count(*), а НЕ count(distinct rid), в отличие от n
              -- выше. Ядро считает ЗНАЧЕНИЯ (numericValues перебирает все ответы записи), а схема
              -- двух ответов под одним ключом не запрещает: distinct схлопнул бы их в один, и гейт
              -- анонимности взял бы разные выборки в памяти и в базе — то есть группа с именем
              -- клиента показывалась бы в одной реализации и исчезала в другой.
              count(*) filter (where ra.question_key = $4 and ra.value_number is not null)::int as nps_n,
              count(*) filter (where ra.question_key = $4 and ra.value_number >= 9)::int as nps_prom,
              count(*) filter (where ra.question_key = $4 and ra.value_number <= 6)::int as nps_detr,
              count(*) filter (where ra.question_key = $5 and ra.value_number is not null)::int as csat_n,
              -- Сумма в float8, а не точное десятичное: ядро складывает в double и делит (sum/n
              -- над JS-числами). На дробных баллах (survey_option.score — numeric) точное среднее и
              -- double-среднее расходятся на границе округления: замерено 3.24 против 3.25 на
              -- шести оценках.
              sum(ra.value_number::float8) filter (where ra.question_key = $5 and ra.value_number is not null) as csat_sum
       from grp g
       left join response_answer ra on ra.response_id = g.rid
       group by g.gkey`,
      params
    )

    const raw: RawGroup[] = rows.rows.map((row) => ({
      name: row.name,
      n: row.n,
      nps: q.npsKey
        ? {
            n: row.nps_n,
            promoters: row.nps_prom,
            passives: row.nps_n - row.nps_prom - row.nps_detr,
            detractors: row.nps_detr,
            // Пустая выборка не делится: `npsFor([])` в ядре тоже отдаёт 0.
            nps: row.nps_n === 0 ? 0 : round1(((row.nps_prom - row.nps_detr) / row.nps_n) * 100)
          }
        : null,
      csat: q.csatKey
        ? {
            n: row.csat_n,
            mean: row.csat_n === 0 ? 0 : round2(Number(row.csat_sum) / row.csat_n),
            // ⚠️ Топ-бокс в срезе НЕ считается: `BreakdownRow` его не несёт (строка среза показывает
            // только NPS и среднее). Он и считался — лишним `count(*) filter` в каждом из четырёх
            // запросов, — и никуда не шёл; заметить это можно было только мутацией, которая ничего
            // не роняет. Ноль здесь честнее выдуманного числа: поле в тип входит, значения нет.
            topBoxPct: 0
          }
        : null
    }))
    return finishBreakdown(raw)
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
    params.push(opts.topBoxMin ?? CSAT_TOP_BOX_MIN)
    // ⚠️ Берём СУММУ в float8 и делим в TS, а не `avg()` в базе. Ядро считает `sum/n` над
    // JS-числами, а numeric-деление Postgres даёт точное десятичное — и на границе округления они
    // расходятся: шесть дробных оценок дают ровно 3.245 в базе (→ 3.25) против 3.2449999999999997
    // в double (→ 3.24). Дробные баллы схема разрешает: `survey_option.score` это `numeric`.
    // Найдено пробой на ревью; та же правка сделана в срезах (`breakdown`).
    const r = await this.db.query<{ n: number; sum: string | number | null; top: number }>(
      `select count(*)::int as n,
              sum(ra.value_number::float8) as sum,
              count(*) filter (where ra.value_number >= $${params.length})::int as top
       ${AGG_FROM}
       where ${where} and ra.value_number is not null`,
      params
    )
    const row = r.rows[0]!
    if (!meetsAnonymity(row.n, minN)) return null
    // после проверки порога n ≥ 1 → сумма по непустой выборке не бывает NULL
    return { n: row.n, mean: round2(Number(row.sum) / row.n), topBoxPct: round1((row.top / row.n) * 100) }
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

  /**
   * Динамика NPS по периодам (SQL-вариант domain/aggregate.npsTrend, #10). Метрику
   * считает БД, ответы в память не грузятся. Бакеты — в UTC (как in-memory: смещение
   * таймзоны не должно сдвигать день/месяц через полночь): `to_char(submitted_at at
   * time zone 'UTC', …)`. Порог подавления — общий `slice()` (на чувствительном срезе
   * порог ANONYMITY_THRESHOLD применяется к КАЖДОЙ точке); бакеты с n < порога отбрасываются.
   * Без `generate_series`: пустые периоды между точками не достраиваются — это
   * паритет с in-memory `npsTrend` (он тоже отдаёт только непустые бакеты).
   * Паритет с in-memory: тот же набор/порядок точек и те же значения метрики.
   */
  async aggregateNpsTrend(f: AggregateFilter, bucket: 'month' | 'day' = 'month'): Promise<TrendPoint[]> {
    const { where, params, minN } = this.slice(f)
    const fmt = bucket === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'
    params.push(fmt)
    const r = await this.db.query<{ bucket: string; n: number; promoters: number; detractors: number }>(
      `select to_char(r.submitted_at at time zone 'UTC', $${params.length}) as bucket,
              count(*)::int as n,
              count(*) filter (where ra.value_number >= 9)::int as promoters,
              count(*) filter (where ra.value_number <= 6)::int as detractors
       ${AGG_FROM}
       where ${where} and ra.value_number is not null
       group by 1 order by 1 asc`,
      params
    )
    const out: TrendPoint[] = []
    for (const row of r.rows) {
      if (!meetsAnonymity(row.n, minN)) continue
      const passives = row.n - row.promoters - row.detractors
      out.push({
        bucket: row.bucket,
        n: row.n,
        promoters: row.promoters,
        passives,
        detractors: row.detractors,
        nps: round1(((row.promoters - row.detractors) / row.n) * 100)
      })
    }
    return out
  }
}
