import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PgStore, queryableFromPool, type PoolLike, type Queryable } from '../src/store/pg'
import { byCategory, byCompany, byProduct, byVersionRange, csatFor, distributionFor, npsFor } from '../src/domain/aggregate'
import { buildDemo, draftV1, draftV2, CSAT_Q, LIKED_Q, NPS_Q, SURVEY_KEY } from '../src/demo/seed'
import type { ResponseRecord } from '../src/domain/schema'

// Реальная схема в pglite (Postgres в WASM, in-process) — тесты идут и локально, и в CI без docker.
const migration = readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8')

// Один общий PGlite на файл (WASM-инициализация дорогая, ~2с). Изоляция тестов —
// отдельными порталами (tenant): ровно та гарантия, которую PgStore и обещает.
let pglite: PGlite
let db: Queryable
beforeAll(async () => {
  pglite = new PGlite()
  await pglite.exec(migration)
  db = pglite as unknown as Queryable
})
afterAll(async () => {
  await pglite.close()
})

let portalSeq = 0
async function fresh(): Promise<{ db: Queryable; portalA: number; portalB: number }> {
  const mk = async (): Promise<number> => {
    const seq = ++portalSeq
    const r = await db.query<{ id: number }>(
      'insert into portal (member_id, domain, tokens) values ($1, $2, $3::jsonb) returning id',
      [`m${seq}`, `p${seq}.b24`, '{}']
    )
    return r.rows[0]!.id
  }
  return { db, portalA: await mk(), portalB: await mk() }
}

function sampleResponse(over: Partial<ResponseRecord> = {}): ResponseRecord {
  return {
    id: 'ext',
    surveyKey: SURVEY_KEY,
    versionNo: 1,
    submittedAt: '2026-04-03T10:00:00.000Z',
    context: {
      dealId: 5001, companyId: 101, dealCategoryId: 1, contactId: 777, responsibleId: 11,
      products: [{ productId: 1001, productName: 'Внедрение' }]
    },
    answers: [
      { questionKey: 'q_nps', metric: 'nps', valueChoice: ['n10'], valueNumber: 10, valueText: null },
      { questionKey: 'q_comment', metric: 'text', valueChoice: [], valueNumber: null, valueText: 'спасибо' }
    ],
    ...over
  }
}

describe('PgStore (pglite)', () => {
  it('ping() — health-проба выполняет select 1 и резолвится (#5)', async () => {
    await expect(new PgStore(db, { portalId: 1 }).ping()).resolves.toBeUndefined()
  })

  it('ping() реджектит, когда драйвер недоступен (#5)', async () => {
    const dead: Queryable = { query: () => Promise.reject(new Error('connection refused')) }
    await expect(new PgStore(dead, { portalId: 1 }).ping()).rejects.toThrow(/connection refused/)
  })

  it('публикует версии, отдаёт по номеру и текущую; иммутабельность', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    await store.publish(draftV2(), 2)
    expect((await store.getVersion(SURVEY_KEY, 1))?.versionNo).toBe(1)
    expect((await store.getVersion(SURVEY_KEY, 2))?.questions.find((q) => q.key === 'q_liked')?.options).toHaveLength(6)
    expect((await store.currentVersion(SURVEY_KEY))?.versionNo).toBe(2)
    await expect(store.publish(draftV1(), 1)).rejects.toThrow(/уже опубликована/)
  })

  it('пустое хранилище → undefined', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    expect(await store.getVersion('nope', 1)).toBeUndefined()
    expect(await store.currentVersion('nope')).toBeUndefined()
  })

  it('addResponse → listResponses: round-trip контекста и ответов', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    await store.addResponse(sampleResponse())
    const list = await store.listResponses()
    expect(list).toHaveLength(1)
    const r = list[0]!
    expect(r.surveyKey).toBe(SURVEY_KEY)
    expect(r.versionNo).toBe(1)
    expect(r.submittedAt).toBe('2026-04-03T10:00:00.000Z')
    expect(r.context.companyId).toBe(101)
    expect(r.context.responsibleId).toBe(11)
    expect(r.context.products).toEqual([{ productId: 1001, productName: 'Внедрение' }])
    expect(r.answers).toHaveLength(2)
    expect(r.answers[0]).toMatchObject({ questionKey: 'q_nps', metric: 'nps', valueNumber: 10, valueChoice: ['n10'] })
    expect(r.answers[1]).toMatchObject({ questionKey: 'q_comment', valueText: 'спасибо' })
    // агрегаты ядра работают поверх выборки из PgStore
    expect(npsFor(list, 'q_nps').nps).toBe(100)
  })

  it('фильтр по surveyKey', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    await store.addResponse(sampleResponse())
    expect(await store.listResponses(SURVEY_KEY)).toHaveLength(1)
    expect(await store.listResponses('other_survey')).toHaveLength(0)
  })

  it('tenant-изоляция: данные одного портала не видны другому', async () => {
    const { db, portalA, portalB } = await fresh()
    const storeA = new PgStore(db, { portalId: portalA })
    const storeB = new PgStore(db, { portalId: portalB })
    await storeA.publish(draftV1(), 1)
    await storeA.addResponse(sampleResponse())
    expect(await storeA.listResponses()).toHaveLength(1)
    expect(await storeB.listResponses()).toHaveLength(0)
    expect(await storeB.currentVersion(SURVEY_KEY)).toBeUndefined()
  })

  it('кастомная группа (groupTitle) и ответ без продуктов', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA, groupTitle: 'HR-опросы' })
    await store.publish(draftV1(), 1)
    // пустой контекст: все денормализуемые поля NULL, продуктов нет
    await store.addResponse(sampleResponse({ id: 'np', context: {} }))
    const list = await store.listResponses()
    expect(list).toHaveLength(1)
    expect(list[0]!.context.products).toBeUndefined()
  })

  it('продукты: с serviceTag и без productName сохраняются', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    await store.addResponse(sampleResponse({
      context: {
        companyId: 101,
        products: [
          { productId: 1002, productName: 'Поддержка', serviceTag: 'svc-x' },
          { productId: 1003 }
        ]
      }
    }))
    const r = (await store.listResponses())[0]!
    expect(r.context.products).toEqual([
      { productId: 1002, productName: 'Поддержка', serviceTag: 'svc-x' },
      { productId: 1003 }
    ])
  })

  it('устойчив к NULL в context/value_choice (строки из внешних источников)', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    const sid = (await db.query<{ id: number }>(
      'select s.id from survey s join survey_group g on g.id = s.group_id where g.portal_id = $1', [portalA]
    )).rows[0]!.id
    const vid = (await db.query<{ id: number }>('select id from survey_version where survey_id = $1', [sid])).rows[0]!.id
    const rid = (await db.query<{ id: number }>(
      'insert into response (portal_id, survey_id, survey_version_id, version_no, submitted_at) values ($1,$2,$3,1,now()) returning id',
      [portalA, sid, vid]
    )).rows[0]!.id
    await db.query(
      "insert into response_answer (response_id, question_key, metric, value_number, value_text, position) values ($1,'q','nps',null,null,0)",
      [rid]
    )
    const got = (await store.listResponses())[0]!
    expect(got.context).toEqual({}) // NULL context → {}
    expect(got.answers[0]!.valueChoice).toEqual([]) // NULL value_choice → []
    expect(got.answers[0]!.valueNumber).toBeNull()
  })

  it('listResponsesPage: keyset-пагинация и фильтр', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    const days = ['2026-04-01', '2026-04-01', '2026-04-02'] // два с равным временем → тай-брейк по id (bigint)
    for (const [i, d] of days.entries()) {
      await store.addResponse(sampleResponse({ id: `r${i}`, submittedAt: `${d}T10:00:00.000Z`, answers: [] }))
    }
    const p1 = await store.listResponsesPage({ limit: 2 })
    expect(p1.items).toHaveLength(2)
    expect(p1.nextCursor).toBeTruthy()
    const p2 = await store.listResponsesPage({ limit: 2, cursor: p1.nextCursor })
    expect(p2.items).toHaveLength(1)
    expect(p2.nextCursor).toBeUndefined()
    // дефолтный лимит + фильтр по surveyKey
    expect((await store.listResponsesPage({ surveyKey: SURVEY_KEY })).items).toHaveLength(3)
    expect((await store.listResponsesPage({ surveyKey: 'nope' })).items).toHaveLength(0)
  })

  it('пагинация: курсор + фильтр surveyKey вместе ($N не сбивается)', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    for (const [i, d] of ['2026-04-01', '2026-04-02', '2026-04-03'].entries()) {
      await store.addResponse(sampleResponse({ id: `r${i}`, submittedAt: `${d}T10:00:00.000Z`, answers: [] }))
    }
    const p1 = await store.listResponsesPage({ limit: 2, surveyKey: SURVEY_KEY })
    expect(p1.items).toHaveLength(2)
    const p2 = await store.listResponsesPage({ limit: 2, surveyKey: SURVEY_KEY, cursor: p1.nextCursor })
    expect(p2.items).toHaveLength(1)
    expect(p2.nextCursor).toBeUndefined()
  })

  it('курсор от другого портала tenant-безопасен (видны только свои данные)', async () => {
    const { db, portalA, portalB } = await fresh()
    const a = new PgStore(db, { portalId: portalA })
    const b = new PgStore(db, { portalId: portalB })
    await a.publish(draftV1(), 1)
    await a.addResponse(sampleResponse({ submittedAt: '2026-04-01T10:00:00.000Z', answers: [] }))
    await a.addResponse(sampleResponse({ submittedAt: '2026-04-02T10:00:00.000Z', answers: [] }))
    const pa = await a.listResponsesPage({ limit: 1 })
    expect((await b.listResponsesPage({ cursor: pa.nextCursor! })).items).toHaveLength(0)
  })

  it('currentVersion = max(version_no) даже при публикации вне порядка', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 2)
    await store.publish(draftV1(), 1)
    expect((await store.currentVersion(SURVEY_KEY))?.versionNo).toBe(2)
  })

  it('addResponse до публикации → ошибка; неизвестная версия → ошибка', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await expect(store.addResponse(sampleResponse())).rejects.toThrow(/не опубликован/)
    await store.publish(draftV1(), 1)
    await expect(store.addResponse(sampleResponse({ versionNo: 5 }))).rejects.toThrow(/не найдена/)
  })
})

/** Обёртка с инъекцией сбоя: запрос, совпавший с failOn, падает (для проверки отката). */
function withFault(db: Queryable, failOn: RegExp): Queryable {
  const wrapped: Queryable = {
    query: (sql, params) =>
      failOn.test(sql) ? Promise.reject(new Error('fault: injected')) : db.query(sql, params)
  }
  if (db.transaction) {
    wrapped.transaction = (fn) => db.transaction!((tx) => fn(withFault(tx, failOn)))
  }
  return wrapped
}

describe('PgStore — транзакции и идемпотентный ensure', () => {
  it('сбой на вставке ответов откатывает response целиком (transaction)', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(withFault(db, /insert into response_answer/), { portalId: portalA })
    await store.publish(draftV1(), 1)
    await expect(store.addResponse(sampleResponse())).rejects.toThrow(/fault/)
    const n = await db.query<{ n: number }>('select count(*)::int as n from response where portal_id = $1', [portalA])
    expect(n.rows[0]!.n).toBe(0) // откатился и response, и его ответы
  })

  it('драйвер без transaction: fallback работает, но запись неатомарна (partial write)', async () => {
    const { db, portalA } = await fresh()
    const queryOnly: Queryable = { query: (sql, params) => db.query(sql, params) }
    const store = new PgStore(queryOnly, { portalId: portalA })
    await store.publish(draftV1(), 1)
    await store.addResponse(sampleResponse())
    expect(await store.listResponses()).toHaveLength(1)

    // Контракт fallback'а: сбой после INSERT response оставляет «пустой» ответ —
    // именно поэтому прод обязан использовать transaction (см. requireTransaction).
    const faulty = new PgStore(withFault(queryOnly, /insert into response_answer/), { portalId: portalA })
    await expect(faulty.addResponse(sampleResponse({ submittedAt: '2026-04-04T10:00:00.000Z' }))).rejects.toThrow(/fault/)
    const r = await db.query<{ n: number }>('select count(*)::int as n from response where portal_id = $1', [portalA])
    const a = await db.query<{ n: number }>(
      'select count(*)::int as n from response_answer ra join response r on r.id = ra.response_id where r.portal_id = $1',
      [portalA]
    )
    expect(r.rows[0]!.n).toBe(2) // второй (оборванный) response остался
    expect(a.rows[0]!.n).toBe(2) // а его ответов нет (только 2 от первого)
  })

  it('requireTransaction: прод-guard падает на драйвере без transaction', async () => {
    const { db, portalA } = await fresh()
    const queryOnly: Queryable = { query: (sql, params) => db.query(sql, params) }
    expect(() => new PgStore(queryOnly, { portalId: portalA, requireTransaction: true }))
      .toThrow(/queryableFromPool/)
    // с транзакционным драйвером guard проходит
    expect(() => new PgStore(db, { portalId: portalA, requireTransaction: true })).not.toThrow()
  })

  it('queryableFromPool: транзакция коммитится, при ошибке откатывается, клиент освобождается', async () => {
    const { db, portalA } = await fresh()
    let released = 0
    const pool: PoolLike = {
      query: (sql, params) => db.query(sql, params),
      connect: async () => ({
        query: (sql, params) => db.query(sql, params),
        release: () => {
          released++
        }
      })
    }
    const store = new PgStore(queryableFromPool(pool), { portalId: portalA, requireTransaction: true })
    await store.publish(draftV1(), 1)
    await store.addResponse(sampleResponse())
    expect(await store.listResponses()).toHaveLength(1)

    const faulty = new PgStore(withFault(queryableFromPool(pool), /insert into response_answer/), { portalId: portalA })
    await expect(faulty.addResponse(sampleResponse({ submittedAt: '2026-04-05T10:00:00.000Z' }))).rejects.toThrow(/fault/)
    const n = await db.query<{ n: number }>('select count(*)::int as n from response where portal_id = $1', [portalA])
    expect(n.rows[0]!.n).toBe(1) // оборванный ответ откатился BEGIN/ROLLBACK'ом фабрики
    expect(released).toBeGreaterThanOrEqual(3) // publish + addResponse + откат: клиент всегда возвращён
  })

  it('queryableFromPool: сбой rollback НЕ маскирует исходную ошибку fn', async () => {
    let released = 0
    const pool: PoolLike = {
      query: (sql, params) => db.query(sql, params),
      connect: async () => ({
        query: (sql, params) =>
          /^rollback$/.test(sql) ? Promise.reject(new Error('rollback failed')) : db.query(sql, params),
        release: () => {
          released++
        }
      })
    }
    const q = queryableFromPool(pool)
    await expect(
      q.transaction!(async () => {
        throw new Error('исходная ошибка fn')
      })
    ).rejects.toThrow(/исходная ошибка fn/) // не «rollback failed»
    expect(released).toBe(1)
    await db.query('rollback') // зачистка: begin прошёл, rollback мы сымитировали упавшим
  })

  it('ensure идемпотентен (ON CONFLICT): повторные publish не плодят группы/опросы', async () => {
    // PGlite однопоточен — конкурентную гонку не воспроизвести; проверяем
    // последовательную идемпотентность (конфликтная ветка INSERT → SELECT).
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    await store.publish(draftV2(), 2)
    const g = await db.query<{ n: number }>('select count(*)::int as n from survey_group where portal_id = $1', [portalA])
    const s = await db.query<{ n: number }>(
      'select count(*)::int as n from survey s join survey_group g on g.id = s.group_id where g.portal_id = $1',
      [portalA]
    )
    expect(g.rows[0]!.n).toBe(1)
    expect(s.rows[0]!.n).toBe(1)
  })
})

describe('PgStore — денормализация контекста', () => {
  it('addResponse заполняет индексируемые колонки и response_product', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await store.publish(draftV1(), 1)
    await store.addResponse(sampleResponse())
    const r = await db.query<{ deal_id: number; company_id: number; deal_category_id: number; contact_id: number; responsible_id: number }>(
      'select deal_id::int, company_id::int, deal_category_id::int, contact_id::int, responsible_id::int from response where portal_id = $1',
      [portalA]
    )
    expect(r.rows[0]).toEqual({ deal_id: 5001, company_id: 101, deal_category_id: 1, contact_id: 777, responsible_id: 11 })
    const p = await db.query<{ product_id: number; product_name: string }>(
      `select rp.product_id::int, rp.product_name from response_product rp
       join response r on r.id = rp.response_id where r.portal_id = $1`,
      [portalA]
    )
    expect(p.rows).toEqual([{ product_id: 1001, product_name: 'Внедрение' }])
  })
})

describe('PgStore — SQL-агрегация (паритет с in-memory на демо-данных)', () => {
  let store: PgStore
  let all: Awaited<ReturnType<PgStore['listResponses']>>

  beforeAll(async () => {
    const { db, portalA } = await fresh()
    store = await buildDemo(new PgStore(db, { portalId: portalA }))
    all = await store.listResponses()
  })

  // Числа срезов — из src/demo/seed.ts (12 ответов): responsible 11 → n=5,
  // 12 → n=4, 13 → n=3; company 101/102 → по 6; product 1001 → 8; category 1 → 8.

  it('NPS: опрос, компания, товар, направление, диапазон версий', async () => {
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q }))
      .toEqual(npsFor(all, NPS_Q))
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, companyId: 101 }))
      .toEqual(npsFor(byCompany(all, 101), NPS_Q))
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, productId: 1001 }))
      .toEqual(npsFor(byProduct(all, 1001), NPS_Q))
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, dealCategoryId: 1 }))
      .toEqual(npsFor(byCategory(all, 1), NPS_Q))
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, versionFrom: 1, versionTo: 1 }))
      .toEqual(npsFor(byVersionRange(all, 1, 1), NPS_Q))
    // versionFrom без versionTo — независимая ветка фильтра
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, versionFrom: 2 }))
      .toEqual(npsFor(all.filter((r) => r.versionNo >= 2), NPS_Q))
  })

  it('CSAT (вкл. topBoxMin) и распределение совпадают с in-memory, в т.ч. на чувствительном срезе', async () => {
    expect(await store.aggregateCsat({ surveyKey: SURVEY_KEY, questionKey: CSAT_Q }))
      .toEqual(csatFor(all, CSAT_Q))
    expect(await store.aggregateCsat({ surveyKey: SURVEY_KEY, questionKey: CSAT_Q }, { topBoxMin: 5 }))
      .toEqual(csatFor(all, CSAT_Q, { topBoxMin: 5 }))
    expect(await store.aggregateDistribution({ surveyKey: SURVEY_KEY, questionKey: LIKED_Q }))
      .toEqual(distributionFor(all, LIKED_Q))
    // sensitive-срез (company 101, n=6 ≥ порога): паритет и для CSAT, и для распределения
    expect(await store.aggregateCsat({ surveyKey: SURVEY_KEY, questionKey: CSAT_Q, companyId: 101 }))
      .toEqual(csatFor(byCompany(all, 101), CSAT_Q))
    expect(await store.aggregateDistribution({ surveyKey: SURVEY_KEY, questionKey: LIKED_Q, companyId: 101 }))
      .toEqual(distributionFor(byCompany(all, 101), LIKED_Q))
  })

  it('принудительное подавление малых N на чувствительных срезах', async () => {
    // responsibleId 12: n=4 < ANONYMITY_THRESHOLD → подавлено даже при minN=1 (нельзя опустить)
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, responsibleId: 12 })).toBeNull()
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, responsibleId: 12, minN: 1 })).toBeNull()
    expect(await store.aggregateDistribution({ surveyKey: SURVEY_KEY, questionKey: LIKED_Q, responsibleId: 12 })).toBeNull()
    // граница: responsible 11 → n=5 = ANONYMITY_THRESHOLD → ПОКАЗЫВАЕТСЯ (≥, не >)
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, responsibleId: 11 }))
      .toEqual(npsFor(all.filter((r) => r.context.responsibleId === 11), NPS_Q))
    // company 101: n=6 ≥ 5 → видим; поднятый minN=7 подавляет
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, companyId: 101 })).not.toBeNull()
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, companyId: 101, minN: 7 })).toBeNull()
    // dealId — чувствительный срез: каждая сделка в seed уникальна (n=1) → всегда подавлено
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, dealId: 5001 })).toBeNull()
    // пустой срез: n=0 → null; неизвестный questionKey → null (не исключение)
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: NPS_Q, companyId: 999 })).toBeNull()
    expect(await store.aggregateCsat({ surveyKey: SURVEY_KEY, questionKey: CSAT_Q, companyId: 999 })).toBeNull()
    expect(await store.aggregateNps({ surveyKey: SURVEY_KEY, questionKey: 'q_нет_такого' })).toBeNull()
    expect(await store.aggregateDistribution({ surveyKey: SURVEY_KEY, questionKey: 'q_нет_такого' })).toBeNull()
  })
})
