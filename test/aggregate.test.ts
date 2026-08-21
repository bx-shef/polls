import { describe, expect, it } from 'vitest'
import {
  ANONYMITY_THRESHOLD,
  breakdownBy,
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
  numericValues,
  suppressSmallBins
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

describe('breakdownBy — обобщённый срез по измерению', () => {
  const mk = (
    id: string,
    nps: number,
    o: { products?: number[]; respId?: number; respName?: string; noAnswer?: boolean } = {}
  ): ResponseRecord => ({
    id, surveyKey: SURVEY_KEY, versionNo: 1, submittedAt: '2026-04-01T10:00:00.000Z',
    context: {
      ...(o.respId != null ? { responsibleId: o.respId, responsibleName: o.respName } : {}),
      ...(o.products ? { products: o.products.map((p) => ({ productId: p, productName: `P${p}` })) } : {})
    },
    answers: o.noAnswer ? [] : [{ questionKey: NPS_Q, metric: 'nps', valueChoice: [`n${nps}`], valueNumber: nps, valueText: null }]
  })
  const byResp = (r: ResponseRecord) =>
    r.context.responsibleId != null ? [{ key: r.context.responsibleId, name: r.context.responsibleName ?? `#${r.context.responsibleId}` }] : []
  const byProd = (r: ResponseRecord) =>
    (r.context.products ?? []).map((p) => ({ key: p.productId, name: p.productName ?? `#${p.productId}` }))

  it('группирует по одиночному ключу, подавляет группу с n < minN', () => {
    const rs = [mk('a', 10, { respId: 11, respName: 'Иванов' }), mk('b', 9, { respId: 11, respName: 'Иванов' }), mk('c', 0, { respId: 12, respName: 'Петров' })]
    expect(breakdownBy(rs, byResp, { npsKey: NPS_Q, minN: 2 })).toEqual([{ name: 'Иванов', n: 2, nps: 100, csat: null }])
  })

  it('мульти-ключ: ответ с двумя продуктами учитывается в обеих группах', () => {
    const rs = [mk('a', 10, { products: [1, 2] }), mk('b', 9, { products: [1] }), mk('c', 3, { products: [2] })]
    expect(breakdownBy(rs, byProd, { npsKey: NPS_Q, minN: 2 })).toEqual([
      { name: 'P1', n: 2, nps: 100, csat: null },
      { name: 'P2', n: 2, nps: 0, csat: null }
    ])
  })

  it('имя — первым вхождением ключа (устойчиво к переименованию в CRM)', () => {
    const rs = [mk('a', 10, { respId: 11, respName: 'Старое' }), mk('b', 10, { respId: 11, respName: 'Новое' })]
    expect(breakdownBy(rs, byResp, { npsKey: NPS_Q, minN: 2 })[0]?.name).toBe('Старое')
  })

  it('метрика обнулена при её собственной выборке < minN; строка без метрик скрыта', () => {
    const rs = [mk('a', 10, { respId: 11, respName: 'И' }), mk('b', 0, { respId: 11, respName: 'И', noAnswer: true })]
    // группа n=2 (≥minN), но NPS-выборка =1 (<minN) → nps null, csat null → строка не выводится
    expect(breakdownBy(rs, byResp, { npsKey: NPS_Q, minN: 2 })).toEqual([])
  })

  it('сортировка по NPS убыв., затем по имени; без метрик-ключей — пусто', () => {
    const rs = [mk('a', 0, { respId: 12, respName: 'Б' }), mk('b', 0, { respId: 12, respName: 'Б' }), mk('c', 10, { respId: 11, respName: 'А' }), mk('d', 10, { respId: 11, respName: 'А' })]
    expect(breakdownBy(rs, byResp, { npsKey: NPS_Q, minN: 2 }).map((r) => r.name)).toEqual(['А', 'Б'])
    expect(breakdownBy(rs, byResp, { minN: 2 })).toEqual([]) // нет npsKey/csatKey → метрик нет → пусто
  })

  it('minN по умолчанию = ANONYMITY_THRESHOLD', () => {
    const four = [11, 12, 13, 14].map((i) => mk(`r${i}`, 10, { respId: 11, respName: 'И' }))
    expect(breakdownBy(four, byResp, { npsKey: NPS_Q })).toEqual([]) // n=4 < 5 → подавлено
    expect(breakdownBy([...four, mk('r15', 10, { respId: 11, respName: 'И' })], byResp, { npsKey: NPS_Q }))
      .toEqual([{ name: 'И', n: 5, nps: 100, csat: null }]) // n=5 ≥ ANONYMITY_THRESHOLD
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
    expect(byVersionRange(all, 2, 1)).toEqual([]) // from > to → пусто
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

describe('k-анонимность распределения по ячейкам (#49)', () => {
  const bins = (...pairs: Array<[string, number]>) => pairs.map(([label, count]) => ({ label, count }))
  const labels = (r: { items: Array<{ label: string }> }) => r.items.map((i) => i.label)

  it('крупные ячейки проходят целиком, скрытого нет', () => {
    const out = suppressSmallBins(bins(['Скорость', 8], ['Цена', 7]))
    expect(out.items).toHaveLength(2)
    expect(out.hiddenBins).toBe(0)
    expect(out.hiddenCount, 'нечего скрывать — суммы быть не должно').toBeNull()
  })

  it('точечная ячейка скрыта, и вместе с ней — самая маленькая из показанных', () => {
    // Скрыв ОДНУ ячейку, мы бы её же и назвали: остаток публикуется, и он был бы равен ей.
    const out = suppressSmallBins(bins(['Скорость', 20], ['Цена', 7], ['Отказ', 1]))
    expect(labels(out)).toEqual(['Скорость'])
    expect(out.hiddenBins).toBe(2)
    expect(out.hiddenCount).toBe(8)
  })

  it('добираем именно САМУЮ МАЛЕНЬКУЮ из показанных, а не первую или последнюю', () => {
    const out = suppressSmallBins(bins(['Цена', 9], ['Скорость', 20], ['Отказ', 2]))
    expect(labels(out)).toEqual(['Скорость'])
  })

  it('ДВЕ точечные ячейки при малом остатке — добираем дальше (#49, найдено ревью)', () => {
    // ⚠️ Первая редакция правила добирала соседа ТОЛЬКО когда скрыта ровно одна ячейка. Здесь
    // скрытых уже две, добор не срабатывал, остаток равнялся 2 на две ячейки — то есть «по одному
    // ответу в каждой», и оба «конкретных человека» назывались. Выборка при этом живая: 23 ответа.
    const out = suppressSmallBins(bins(['A', 12], ['B', 9], ['C', 1], ['D', 1]))
    expect(labels(out)).toEqual(['A'])
    expect(out.hiddenBins).toBe(3)
    expect(out.hiddenCount, 'остаток обязан быть не меньше порога').toBe(11)
  })

  it('остаток из двух единиц при одной крупной ячейке → не показываем НИЧЕГО', () => {
    // `[20, 1, 1]`: показать 20 значило бы назвать обе единицы (остаток 2 на две ячейки).
    const out = suppressSmallBins(bins(['Скорость', 20], ['C', 1], ['D', 1]))
    expect(out.items).toEqual([])
    expect(out.hiddenBins).toBe(3)
    expect(out.hiddenCount).toBe(22)
  })

  it('два варианта и у одного единица → не показываем НИЧЕГО', () => {
    const out = suppressSmallBins(bins(['Скорость', 40], ['Отказ', 1]))
    expect(out.items).toEqual([])
    expect(out.hiddenBins).toBe(2)
    expect(out.hiddenCount).toBe(41)
  })

  it('единственная малая ячейка: сумму НЕ печатаем — она назвала бы эту ячейку', () => {
    const out = suppressSmallBins(bins(['Отказ', 1]))
    expect(out.items).toEqual([])
    expect(out.hiddenBins).toBe(1)
    expect(out.hiddenCount).toBeNull()
  })

  it('инвариант остатка держится на всех входах: скрытых ≥2 и сумма ≥ порога', () => {
    // Свойство важнее любого отдельного примера: остаток публикуется, значит по построению обязан
    // распадаться минимум на две ячейки и быть не меньше порога — иначе он называет ячейку.
    const cases = [
      bins(['a', 1]), bins(['a', 1], ['b', 1]), bins(['a', 20], ['b', 1], ['c', 1]),
      bins(['a', 12], ['b', 9], ['c', 1], ['d', 1]), bins(['a', 5], ['b', 5], ['c', 1]),
      bins(['a', 3], ['b', 4], ['c', 4], ['d', 2], ['e', 2], ['f', 2]),
      bins(['a', 100], ['b', 4]), bins(['a', 6], ['b', 6], ['c', 6])
    ]
    for (const input of cases) {
      const out = suppressSmallBins(input)
      const why = JSON.stringify(input)
      const total = input.reduce((a, i) => a + i.count, 0)
      const hiddenSum = total - out.items.reduce((a, i) => a + i.count, 0)
      // Ни одна ПОКАЗАННАЯ ячейка не мала — это и есть первый уровень правила.
      for (const i of out.items) expect(i.count, why).toBeGreaterThanOrEqual(ANONYMITY_THRESHOLD)
      expect(out.hiddenBins, why).toBe(input.length - out.items.length)
      if (out.hiddenCount === null) {
        // Сумму не публикуем ровно по двум причинам, и обе обязаны быть настоящими.
        expect(out.hiddenBins < 2 || hiddenSum < ANONYMITY_THRESHOLD, `${why}: сумму скрыли зря`).toBe(true)
        continue
      }
      expect(out.hiddenCount, why).toBe(hiddenSum)
      expect(out.hiddenBins, why).toBeGreaterThanOrEqual(2)
      expect(out.hiddenCount, why).toBeGreaterThanOrEqual(ANONYMITY_THRESHOLD)
    }
  })

  it('демо-данные проекта: все шесть ячеек малы → показываем сумму, а не пустоту', () => {
    // ⚠️ Ровно то, что лежит в `src/demo/seed.ts` (12 ответов, вопрос «Что понравилось»). Без строки
    // «Другие варианты» карточка на демо-дашборде оказалась бы пустой при 12 ответах — экран,
    // который человек прочтёт как поломку.
    const out = suppressSmallBins(bins(['quality', 4], ['support', 4], ['speed', 3], ['price', 2], ['other', 2], ['design', 2]))
    expect(out.items).toEqual([])
    expect(out.hiddenBins).toBe(6)
    expect(out.hiddenCount).toBe(17)
  })

  it('порог настраиваемый и по умолчанию равен общему порогу анонимности', () => {
    const input = bins(['a', 4], ['b', 4], ['c', 9], ['d', 9])
    expect(ANONYMITY_THRESHOLD).toBe(5)
    expect(labels(suppressSmallBins(input))).toEqual(['c', 'd'])
    expect(suppressSmallBins(input, 2).hiddenBins).toBe(0)
  })

  it('ячейка с нулём — не «редкий вариант», её никто не деанонимизирует', () => {
    // ⚠️ Сегодня `distributionFor` пустых ячеек не создаёт, но станет создавать в тот день, когда
    // захочется печатать ВСЕ варианты вопроса, включая невыбранные. Тогда ноль потянул бы за собой
    // живую соседнюю ячейку — правило начало бы прятать данные без единой причины.
    const out = suppressSmallBins([{ label: 'a', count: 0 }, { label: 'b', count: 9 }, { label: 'c', count: 9 }])
    expect(out.items.map((i) => i.label), 'ноль съел живую ячейку').toEqual(['b', 'c'])
    expect(out.hiddenBins, 'пустая ячейка посчитана скрытой — скрывать в ней нечего').toBe(0)
    expect(out.hiddenCount).toBeNull()
  })

  it('порог 0 не прячет ничего — вырожденный, но определённый случай', () => {
    const out = suppressSmallBins(bins(['a', 1], ['b', 2]), 0)
    expect(out.hiddenBins).toBe(0)
    expect(out.items).toHaveLength(2)
  })

  it('пустой вход — пустой выход', () => {
    expect(suppressSmallBins([])).toEqual({ items: [], hiddenBins: 0, hiddenCount: null })
  })

  it('вход НЕ мутируется — вызывающий сортирует его сам', () => {
    const input = bins(['Скорость', 20], ['Отказ', 1])
    suppressSmallBins(input)
    expect(input).toHaveLength(2)
    expect(input[0]!.count).toBe(20)
  })
})
