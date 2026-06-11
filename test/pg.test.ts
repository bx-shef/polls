import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PgStore, type Queryable } from '../src/store/pg'
import { npsFor } from '../src/domain/aggregate'
import { draftV1, draftV2, SURVEY_KEY } from '../src/demo/seed'
import type { ResponseRecord } from '../src/domain/schema'

// Реальная схема в pglite (Postgres в WASM, in-process) — тесты идут и локально, и в CI без docker.
const migration = readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8')

async function fresh(): Promise<{ db: Queryable; portalA: number; portalB: number }> {
  const pg = new PGlite()
  await pg.exec(migration)
  const db = pg as unknown as Queryable
  const a = await db.query<{ id: number }>("insert into portal (member_id, domain, tokens) values ('mA','a.b24','{}'::jsonb) returning id")
  const b = await db.query<{ id: number }>("insert into portal (member_id, domain, tokens) values ('mB','b.b24','{}'::jsonb) returning id")
  return { db, portalA: a.rows[0]!.id, portalB: b.rows[0]!.id }
}

function sampleResponse(over: Partial<ResponseRecord> = {}): ResponseRecord {
  return {
    id: 'ext',
    surveyKey: SURVEY_KEY,
    versionNo: 1,
    submittedAt: '2026-04-03T10:00:00.000Z',
    context: {
      dealId: 5001, companyId: 101, dealCategoryId: 1, responsibleId: 11,
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
    await store.addResponse(sampleResponse({ id: 'np', context: { companyId: 102, responsibleId: 12 } }))
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

  it('addResponse до публикации → ошибка; неизвестная версия → ошибка', async () => {
    const { db, portalA } = await fresh()
    const store = new PgStore(db, { portalId: portalA })
    await expect(store.addResponse(sampleResponse())).rejects.toThrow(/не опубликован/)
    await store.publish(draftV1(), 1)
    await expect(store.addResponse(sampleResponse({ versionNo: 5 }))).rejects.toThrow(/не найдена/)
  })
})
