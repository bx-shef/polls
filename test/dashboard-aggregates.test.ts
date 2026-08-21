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

/**
 * Состязательная фикстура паритета — ОДНА на все краевые случаи (#49, по итогам ревью).
 *
 * ⚠️ Демо-сид доказывал совпадение реализаций на данных, которые не содержат ни одной из ситуаций,
 * ради которых общий хвост и написан: там все даты различны, баллы целые, ничьих по NPS нет, каждый
 * ответ отвечает на всё, а месяцев ровно два и оба выше порога. Мутации, снимающие подавление точек
 * тренда, сортировку `order by` в имени группы, приведение времени к UTC и добор по имени в
 * сортировке срезов, проходили ВЕСЬ набор.
 *
 * Каждый блок ниже подписан тем, что он ловит. Один сид на оба хранилища — pglite небыстрый.
 */
async function seedAdversarial(store: MemoryStore | PgStore): Promise<void> {
  const nps = (v: number) => [{ questionKey: NPS_Q, metric: 'nps' as const, valueChoice: [], valueNumber: v, valueText: null }]

  // (1) МЕСЯЦ С МАЛОЙ ВЫБОРКОЙ — ловит `minN: 1` в тренде: одна точка на одного человека.
  await store.addResponse({
    id: 'lonely-march', surveyKey: SURVEY_KEY, versionNo: 2,
    submittedAt: '2026-03-15T10:00:00.000Z', context: {}, answers: nps(10)
  })

  // (2) НИЧЬЯ ПО МОМЕНТУ ОТВЕТА — ловит потерю `order by` в имени группы и разный ключ сортировки.
  // `zzz` вставлен ПЕРВЫМ: лексикографически он последний, по порядку вставки — первый.
  for (const [id, name] of [['zzz-first', 'Имя-ИЗ-ZZZ'], ['aaa-second', 'Имя-ИЗ-AAA']] as const) {
    await store.addResponse({
      id, surveyKey: SURVEY_KEY, versionNo: 2, submittedAt: '2027-03-01T10:00:00.000Z',
      context: { companyId: 909, companyName: name }, answers: nps(10)
    })
  }
  for (let i = 0; i < 3; i++) {
    await store.addResponse({
      id: `tie-filler-${i}`, surveyKey: SURVEY_KEY, versionNo: 2,
      submittedAt: `2027-03-0${i + 2}T10:00:00.000Z`,
      context: { companyId: 909, companyName: 'Имя-ПОЗЖЕ' }, answers: nps(10)
    })
  }

  // (2б) САМЫЙ РАННИЙ ОТВЕТ ГРУППЫ ВСТАВЛЕН ПОСЛЕДНИМ — ловит потерю `order by` в `array_agg`: без
  // сортировки агрегат берёт порядок скана, то есть порядок вставки, и имя оказывается не тем.
  for (let i = 0; i < 4; i++) {
    await store.addResponse({
      id: `late-scan-${i}`, surveyKey: SURVEY_KEY, versionNo: 2,
      submittedAt: `2027-09-1${i + 1}T10:00:00.000Z`,
      context: { companyId: 910, companyName: 'Имя-ПОЗДНЕЕ' }, answers: nps(10)
    })
  }
  await store.addResponse({
    id: 'earliest-inserted-last', surveyKey: SURVEY_KEY, versionNo: 2,
    submittedAt: '2027-09-01T10:00:00.000Z',
    context: { companyId: 910, companyName: 'Имя-САМОЕ-РАННЕЕ' }, answers: nps(10)
  })

  // (3) РАВНЫЙ NPS У ДВУХ ГРУПП — ловит потерю добора по имени в сортировке `finishBreakdown`.
  for (const [cid, name] of [[801, 'Бета'], [802, 'Альфа']] as const) {
    for (let i = 0; i < 5; i++) {
      await store.addResponse({
        id: `same-nps-${cid}-${i}`, surveyKey: SURVEY_KEY, versionNo: 2,
        submittedAt: `2027-07-0${i + 1}T10:00:00.000Z`,
        context: { companyId: cid, companyName: name }, answers: nps(9)
      })
    }
  }

  // (4) ВОПРОС-МЕТРИКА ПРОПУЩЕН — ловит лишний порог на верхних NPS/CSAT: группа есть, метрики мало.
  for (let i = 0; i < 5; i++) {
    await store.addResponse({
      id: `silent-${i}`, surveyKey: SURVEY_KEY, versionNo: 2,
      submittedAt: `2027-08-0${i + 1}T10:00:00.000Z`,
      context: { responsibleId: 555, responsibleName: 'Молчун' },
      answers: i < 2 ? nps(9) : []
    })
  }

  // (5) ДРОБНЫЕ БАЛЛЫ — ловит точное десятичное деление вместо double: 19.47/6 это 3.245 в базе и
  // 3.2449999999999997 в double, то есть 3.25 против 3.24.
  for (const [i, v] of [4.84, 0.35, 2.19, 4.9, 3.74, 3.45].entries()) {
    await store.addResponse({
      id: `frac-${i}`, surveyKey: SURVEY_KEY, versionNo: 2,
      submittedAt: `2027-04-0${i + 1}T10:00:00.000Z`,
      context: { companyId: 777, companyName: 'Дробная' },
      answers: [{ questionKey: CSAT_Q, metric: 'csat', valueChoice: [], valueNumber: v, valueText: null }]
    })
  }

  // (6) ГРАНИЦА МЕСЯЦА — вместе с не-UTC таймзоной сессии ловит потерю `at time zone 'UTC'`.
  for (let i = 0; i < 5; i++) {
    await store.addResponse({
      id: `edge-${i}`, surveyKey: SURVEY_KEY, versionNo: 2,
      submittedAt: '2026-06-30T23:30:00.000Z', context: {}, answers: nps(9)
    })
  }

  // (7) ОДИН ОТВЕТ — ДВА ТОВАРА, и имя без снимка CRM (фолбэк `#id`).
  for (let i = 0; i < 5; i++) {
    await store.addResponse({
      id: `multi-${i}`, surveyKey: SURVEY_KEY, versionNo: 2,
      submittedAt: `2027-05-0${i + 1}T10:00:00.000Z`,
      context: { products: [{ productId: 7001, productName: 'Аудит' }, { productId: 7002 }] },
      answers: nps(9)
    })
  }
}

describe('агрегаты дашборда: паритет на КРАЕВЫХ данных (найдено ревью)', () => {
  let mem: MemoryStore
  let pg: PgStore
  beforeAll(async () => {
    // ⚠️ Таймзона сессии НЕ UTC намеренно: иначе `at time zone 'UTC'` в тренде удаляется молча —
    // pglite стартует в UTC, и приведение становится тождеством.
    // ⚠️ Таймзона сессии НЕ UTC намеренно: иначе `at time zone 'UTC'` в тренде удаляется молча —
    // pglite стартует в UTC, и приведение становится тождеством.
    await pglite.exec("set time zone 'Asia/Kamchatka'")
    mem = await buildDemo(new MemoryStore())
    pg = await buildDemo(await pgStore())
    await Promise.all([seedAdversarial(mem), seedAdversarial(pg)])
  })

  it('весь ответ порта совпадает целиком', async () => {
    const [a, b] = await Promise.all([mem.dashboardAggregates(FULL), pg.dashboardAggregates(FULL)])
    expect(b).toEqual(a)
  })

  it('фикстура действительно содержит краевые случаи — иначе паритет сравнивает пустоту', async () => {
    const a = await mem.dashboardAggregates(FULL)
    // (1) месяц с одним ответом подавлен в тренде, а месяцы с выборкой — есть.
    expect(a.trend.map((p) => p.bucket), 'месяц из одного ответа виден в тренде').not.toContain('2026-03')
    expect(a.trend.length).toBeGreaterThan(1)
    // (2) имя группы взято из ПЕРВОГО вставленного, а не лексикографически первого.
    expect(a.clients.find((c) => c.n === 5 && ['Имя-ИЗ-ZZZ', 'Имя-ИЗ-AAA'].includes(c.name))?.name)
      .toBe('Имя-ИЗ-ZZZ')
    // (3) две группы с равным NPS — порядок решает имя.
    const same = a.clients.filter((c) => ['Альфа', 'Бета'].includes(c.name)).map((c) => c.name)
    expect(same, 'ничьей по NPS в фикстуре нет').toEqual(['Альфа', 'Бета'])
    // (4) у группы 5 ответов, но метрику дали двое — метрика подавлена, строка осталась по CSAT? нет:
    // без метрик строка не выводится вовсе.
    expect(a.responsibles.map((r) => r.name), 'группа с подавленной метрикой всё же показана')
      .not.toContain('Молчун')
    // (5) дробное среднее посчитано как в ядре.
    expect(a.clients.find((c) => c.name === 'Дробная')?.csat).toBe(3.24)
    // (6) граница месяца в UTC, а не в таймзоне сессии.
    expect(a.trend.map((p) => p.bucket)).toContain('2026-06')
    // (2б) имя взято у самого раннего ответа, хотя вставлен он последним.
    expect(a.clients.find((c) => c.n === 5 && c.name.startsWith('Имя-'))?.name).toBeDefined()
    expect(a.clients.map((c) => c.name), 'взято имя по порядку скана, а не по времени ответа')
      .toContain('Имя-САМОЕ-РАННЕЕ')
    // (7) фолбэк имени товара.
    expect(a.services.map((x) => x.name)).toEqual(expect.arrayContaining(['Аудит', '#7002']))
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
