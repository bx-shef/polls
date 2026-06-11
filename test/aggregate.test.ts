import { describe, expect, it } from 'vitest'
import {
  ANONYMITY_THRESHOLD,
  byCategory,
  byCompany,
  byProduct,
  bySurvey,
  byVersion,
  byVersionRange,
  cesFor,
  choiceValues,
  csatFor,
  distributionFor,
  kpiByResponsible,
  meetsAnonymity,
  npsFor,
  npsTrend,
  numericValues
} from '../src/domain/aggregate'
import { buildDemo, CSAT_Q, LIKED_Q, NPS_Q, SURVEY_KEY } from '../src/demo/seed'
import type { ResponseRecord } from '../src/domain/schema'

const all = await (await buildDemo()).listResponses()

describe('итог — уровень 1 (по опросу)', () => {
  const s = bySurvey(all, SURVEY_KEY)
  it('NPS по всем 12 ответам', () => {
    const r = npsFor(s, NPS_Q)
    expect(r.n).toBe(12)
    expect(r.nps).toBe(8.3)
  })
  it('CSAT среднее и топ-бокс', () => {
    const r = csatFor(s, CSAT_Q)
    expect(r.n).toBe(12)
    expect(r.mean).toBe(3.67)
    expect(r.topBoxPct).toBe(58.3)
  })
  it('распределение объединяет варианты по ключу через версии (включая новый design)', () => {
    expect(distributionFor(s, LIKED_Q)).toEqual({
      speed: 3, quality: 4, support: 4, price: 2, other: 2, design: 2
    })
  })
})

describe('итог — уровень 2 (по услуге/товару)', () => {
  it('Внедрение (1001)', () => {
    const sub = byProduct(all, 1001)
    expect(sub).toHaveLength(8)
    expect(npsFor(sub, NPS_Q).nps).toBe(50)
    expect(csatFor(sub, CSAT_Q).mean).toBe(4.25)
  })
  it('Поддержка (1002)', () => {
    const sub = byProduct(all, 1002)
    expect(sub).toHaveLength(6)
    expect(npsFor(sub, NPS_Q).nps).toBe(-50)
  })
})

describe('итог — уровень 3 (по клиенту)', () => {
  it('клиент 101 — здоровый', () => {
    const sub = byCompany(all, 101)
    expect(sub).toHaveLength(6)
    expect(npsFor(sub, NPS_Q).nps).toBe(66.7)
    expect(csatFor(sub, CSAT_Q).mean).toBe(4.5)
    expect(csatFor(sub, CSAT_Q).topBoxPct).toBe(100)
  })
  it('клиент 102 — проблемный', () => {
    expect(npsFor(byCompany(all, 102), NPS_Q).nps).toBe(-50)
  })
})

describe('итог — уровень 4 (по направлению + KPI)', () => {
  it('направления', () => {
    expect(npsFor(byCategory(all, 1), NPS_Q).nps).toBe(37.5)
    expect(npsFor(byCategory(all, 2), NPS_Q).nps).toBe(-50)
  })
  it('KPI по ответственному с порогом N≥2, отсортирован по NPS', () => {
    const kpi = kpiByResponsible(all, NPS_Q, { minN: 2 })
    expect(kpi.map((k) => [k.responsibleId, k.summary.nps])).toEqual([
      [11, 60],
      [13, 33.3],
      [12, -75]
    ])
  })
  it('порог отсекает мелкие выборки', () => {
    expect(kpiByResponsible(all, NPS_Q, { minN: 6 })).toEqual([])
  })
})

describe('итог — тренд (версионно-безопасный)', () => {
  it('NPS по месяцам через границу версий v1→v2', () => {
    const t = npsTrend(all, NPS_Q, 'month')
    expect(t.map((p) => [p.bucket, p.nps, p.n])).toEqual([
      ['2026-04', 16.7, 6],
      ['2026-05', 0, 6]
    ])
  })

  it('тренд по дням — 12 точек, отсортированы', () => {
    const t = npsTrend(all, NPS_Q, 'day')
    expect(t).toHaveLength(12)
    expect(t[0]?.bucket).toBe('2026-04-03')
    expect(t.at(-1)?.bucket).toBe('2026-05-25')
  })
})

describe('итог — прямые выборки и граничные случаи', () => {
  it('numericValues/choiceValues тянут значения по ключу', () => {
    const s = bySurvey(all, SURVEY_KEY)
    expect(numericValues(s, NPS_Q)).toHaveLength(12)
    expect(choiceValues(s, LIKED_Q)).toHaveLength(12)
  })

  it('cesFor считает среднее усилие по ключу', () => {
    expect(cesFor(bySurvey(all, SURVEY_KEY), CSAT_Q)).toEqual({ n: 12, mean: 3.67 })
  })

  it('KPI игнорирует ответы без responsibleId', () => {
    const extra: ResponseRecord[] = [
      ...all,
      {
        id: 'z1', surveyKey: SURVEY_KEY, versionNo: 2, submittedAt: '2026-05-30T10:00:00.000Z',
        context: {}, // без responsibleId
        answers: [{ questionKey: NPS_Q, metric: 'nps', valueChoice: ['n10'], valueNumber: 10, valueText: null }]
      }
    ]
    // строка без ответственного не создаёт группу → KPI не меняется
    expect(kpiByResponsible(extra, NPS_Q, { minN: 2 })).toEqual(kpiByResponsible(all, NPS_Q, { minN: 2 }))
  })
})

describe('граничные случаи — пустая выборка', () => {
  it('все агрегаты на rs=[] не падают и дают пустые значения', () => {
    expect(numericValues([], NPS_Q)).toEqual([])
    expect(choiceValues([], LIKED_Q)).toEqual([])
    expect(npsFor([], NPS_Q)).toEqual({ n: 0, promoters: 0, passives: 0, detractors: 0, nps: 0 })
    expect(csatFor([], CSAT_Q)).toEqual({ n: 0, mean: 0, topBoxPct: 0 })
    expect(cesFor([], CSAT_Q)).toEqual({ n: 0, mean: 0 })
    expect(distributionFor([], LIKED_Q)).toEqual({})
    expect(kpiByResponsible([], NPS_Q)).toEqual([])
    expect(npsTrend([], NPS_Q, 'month')).toEqual([])
    expect(npsTrend([], NPS_Q, 'day')).toEqual([])
  })
})

describe('byProduct — отсутствие поля products', () => {
  it('запись без products не попадает в срез по товару', () => {
    const rec: ResponseRecord = {
      id: 'np', surveyKey: SURVEY_KEY, versionNo: 1, submittedAt: '2026-04-01T10:00:00.000Z',
      context: { companyId: 1 }, answers: []
    }
    expect(byProduct([rec], 1001)).toEqual([])
  })
})

describe('npsTrend — содержательный бакет по дню', () => {
  it('день 2026-04-03 = единственный ответ nps 10 → nps 100, n 1', () => {
    const t = npsTrend(all, NPS_Q, 'day')
    const day = t.find((p) => p.bucket === '2026-04-03')
    expect(day?.nps).toBe(100)
    expect(day?.n).toBe(1)
  })
})

describe('kpiByResponsible — дефолтный порог = ANONYMITY_THRESHOLD (5)', () => {
  it('без minN отсекает выборки <5: остаётся только ответственный 11 (n=5)', () => {
    expect(ANONYMITY_THRESHOLD).toBe(5)
    const kpi = kpiByResponsible(all, NPS_Q)
    expect(kpi).toHaveLength(1)
    expect(kpi[0]?.responsibleId).toBe(11)
    expect(kpi[0]?.summary.n).toBe(5)
    expect(kpi[0]?.summary.nps).toBe(60)
  })
})

describe('meetsAnonymity', () => {
  it('порог по умолчанию и явный', () => {
    expect(meetsAnonymity(5)).toBe(true)
    expect(meetsAnonymity(4)).toBe(false)
    expect(meetsAnonymity(2, 2)).toBe(true)
    expect(meetsAnonymity(1, 2)).toBe(false)
  })
})

describe('срезы по версии и подавление тренда (read-API)', () => {
  it('byVersion / byVersionRange', () => {
    expect(byVersion(all, 1)).toHaveLength(6)
    expect(byVersion(all, 2)).toHaveLength(6)
    expect(byVersionRange(all, 1, 2)).toHaveLength(12)
    expect(byVersionRange(all, 2, 2)).toHaveLength(6)
  })

  it('npsTrend с minN подавляет малые бакеты', () => {
    // по дням каждый бакет n=1 → при minN=2 пусто; по месяцам n=6 остаются, при minN=7 — пусто
    expect(npsTrend(all, NPS_Q, 'day', 2)).toEqual([])
    expect(npsTrend(all, NPS_Q, 'month', 6)).toHaveLength(2)
    expect(npsTrend(all, NPS_Q, 'month', 7)).toEqual([])
  })
})

describe('npsTrend — сортировка бакетов не зависит от порядка вставки', () => {
  it('ответы в обратном хронологическом порядке → бакеты по возрастанию', () => {
    const mk = (id: string, date: string, n: number): ResponseRecord => ({
      id, surveyKey: SURVEY_KEY, versionNo: 1, submittedAt: `${date}T10:00:00.000Z`,
      context: {}, answers: [{ questionKey: NPS_Q, metric: 'nps', valueChoice: [], valueNumber: n, valueText: null }]
    })
    // Вставка май→апрель: компаратор должен переставить (ветвь a > b).
    const rs = [mk('b', '2026-05-10', 9), mk('a', '2026-04-10', 9)]
    expect(npsTrend(rs, NPS_Q, 'month').map((p) => p.bucket)).toEqual(['2026-04', '2026-05'])
  })
})
