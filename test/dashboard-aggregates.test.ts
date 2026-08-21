import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PgStore, type Queryable } from '../src/store/pg'
import { MemoryStore } from '../src/store/memory'
import { buildDemo, CSAT_Q, LIKED_Q, NPS_Q, SURVEY_KEY } from '../src/demo/seed'
import type { DashboardQuery } from '../src/store/types'
import { applySchema } from './helpers/schema'

/**
 * ПАРИТЕТ агрегатов дашборда: память против SQL (#49).
 *
 * ⚠️ Это главный тест работы, и он не про «оба не падают». Пока дашборд считал в памяти, форма
 * ответа была одна по построению. Теперь их две: чистая `dashboardFromResponses` (dev, демо,
 * инсталляции без базы) и SQL `PgStore.dashboardAggregates` (прод). Разъехавшись, они дадут не
 * «немного другие цифры», а разные NPS у сотрудников на одном и том же наборе ответов — и заметит
 * это только тот, кто сравнит две инсталляции.
 *
 * Поэтому сравнивается ВЕСЬ объект целиком, на одних и тех же данных, во всех срезах.
 */
let pglite: PGlite
let db: Queryable
beforeAll(async () => {
  pglite = new PGlite()
  await applySchema(pglite)
  db = pglite as unknown as Queryable
})
afterAll(async () => {
  await pglite.close()
})

let seq = 0
async function pgStore(): Promise<PgStore> {
  const n = ++seq
  const r = await db.query<{ id: number }>(
    'insert into portal (member_id, domain, tokens) values ($1, $2, $3::jsonb) returning id',
    [`dash-m${n}`, `dash-p${n}.b24`, '{}']
  )
  return new PgStore(db, { portalId: r.rows[0]!.id })
}

const FULL: DashboardQuery = {
  surveyKey: SURVEY_KEY, npsKey: NPS_Q, csatKey: CSAT_Q, choiceKey: LIKED_Q
}

describe('агрегаты дашборда: память и SQL считают ОДНО И ТО ЖЕ (#49)', () => {
  let mem: MemoryStore
  let pg: PgStore
  beforeAll(async () => {
    mem = await buildDemo(new MemoryStore())
    pg = await buildDemo(await pgStore())
  })

  const cases: Array<[string, DashboardQuery]> = [
    ['все версии', FULL],
    ['версия 1', { ...FULL, versionNo: 1 }],
    ['версия 2', { ...FULL, versionNo: 2 }],
    ['несуществующая версия', { ...FULL, versionNo: 99 }],
    ['без вопроса NPS', { ...FULL, npsKey: undefined }],
    ['без вопроса CSAT', { ...FULL, csatKey: undefined }],
    ['без вопроса выбора', { ...FULL, choiceKey: undefined }],
    ['вообще без метрик', { surveyKey: SURVEY_KEY }],
    ['чужой опрос', { ...FULL, surveyKey: 'нет-такого' }]
  ]

  it.each(cases)('%s', async (_name, q) => {
    const [a, b] = await Promise.all([mem.dashboardAggregates(q), pg.dashboardAggregates(q)])
    expect(b).toEqual(a)
  })

  it('срез считается не пустым — иначе паритет доказывал бы совпадение нулей', async () => {
    // ⚠️ Без этой проверки весь набор выше проходит на двух пустых объектах: например если SQL молча
    // не находит опрос (опечатка в имени таблицы), а память тоже вернёт пусто на чужом ключе.
    const a = await pg.dashboardAggregates(FULL)
    expect(a.n).toBeGreaterThan(0)
    expect(a.versions).toEqual([1, 2])
    expect(a.nps?.n).toBeGreaterThan(0)
    expect(a.csat?.n).toBeGreaterThan(0)
    expect(Object.keys(a.distribution ?? {}).length).toBeGreaterThan(0)
    expect(a.trend.length).toBeGreaterThan(0)
    expect(a.services.length, 'срез по услугам пуст — сравнивать нечего').toBeGreaterThan(0)
    expect(a.clients.length).toBeGreaterThan(0)
    expect(a.responsibles.length).toBeGreaterThan(0)
    expect(a.directions.length).toBeGreaterThan(0)
  })
})

describe('агрегаты дашборда: SQL-специфика', () => {
  it('чужой портал не виден: тот же опрос в другом тенанте даёт ноль', async () => {
    // ⚠️ Ключ опроса тенанта НЕ задаёт (уникальность в схеме — `(group_id, survey_key)`), поэтому
    // один и тот же `survey_key` живёт у всех порталов. Без `portal_id` в каждом запросе дашборд
    // показал бы сотруднику одного заказчика ответы другого — с именами клиентов.
    const a = await buildDemo(await pgStore())
    const b = await pgStore()
    const out = await b.dashboardAggregates(FULL)
    expect(out.n).toBe(0)
    expect(out.versions).toEqual([])
    expect(out.services).toEqual([])
    expect((await a.dashboardAggregates(FULL)).n, 'соседний портал тоже опустел').toBeGreaterThan(0)
  })

  it('версии считаются ДО фильтра — селектор не схлопывается после клика', async () => {
    const pg = await buildDemo(await pgStore())
    const out = await pg.dashboardAggregates({ ...FULL, versionNo: 1 })
    expect(out.versions, 'после среза остались только свои версии').toEqual([1, 2])
    expect(out.n, 'фильтр по версии не применился').toBeLessThan(
      (await pg.dashboardAggregates(FULL)).n
    )
  })

  it('имя группы берётся из ПЕРВОГО ответа — переименование в CRM его не двигает', async () => {
    // ⚠️ Порядок `(submitted_at, id)` тот же, что у `listResponses`. Разойдись он — память и SQL
    // выбрали бы разные имена одной и той же группы, и на дашборде оно «прыгало» бы между
    // инсталляциями с базой и без.
    const pg = await pgStore()
    const mem = new MemoryStore()
    for (const store of [pg, mem] as const) {
      await buildDemo(store)
      await store.addResponse({
        id: 'renamed', surveyKey: SURVEY_KEY, versionNo: 2,
        submittedAt: '2027-01-01T10:00:00.000Z',
        context: { companyId: 101, companyName: 'ООО Ромашка (переименована)', responsibleId: 11 },
        answers: [{ questionKey: NPS_Q, metric: 'nps', valueChoice: [], valueNumber: 10, valueText: null }]
      })
    }
    const [a, b] = await Promise.all([mem.dashboardAggregates(FULL), pg.dashboardAggregates(FULL)])
    expect(b.clients).toEqual(a.clients)
    expect(b.clients.map((c) => c.name), 'взято новое имя вместо первого')
      .not.toContain('ООО Ромашка (переименована)')
  })
})
