import { describe, expect, it } from 'vitest'
import {
  byCategory,
  byCompany,
  byProduct,
  bySurvey,
  choiceValues,
  csatFor,
  distributionFor,
  kpiByResponsible,
  npsFor,
  npsTrend,
  numericValues
} from '../src/domain/aggregate'
import { buildDemo, CSAT_Q, LIKED_Q, NPS_Q, SURVEY_KEY } from '../src/demo/seed'
import type { ResponseRecord } from '../src/domain/schema'

const all = buildDemo().responses

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

  it('тренд по дням — bucket формата YYYY-MM-DD', () => {
    const t = npsTrend(all, NPS_Q, 'day')
    expect(t.length).toBeGreaterThan(2)
    expect(t[0]?.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('итог — прямые выборки и граничные случаи', () => {
  it('numericValues/choiceValues тянут значения по ключу', () => {
    const s = bySurvey(all, SURVEY_KEY)
    expect(numericValues(s, NPS_Q)).toHaveLength(12)
    expect(choiceValues(s, LIKED_Q)).toHaveLength(12)
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
