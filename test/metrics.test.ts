import { describe, expect, it } from 'vitest'
import { csat, distribution, nps, round1, round2 } from '../src/domain/metrics'

describe('round', () => {
  it('round1/round2', () => {
    expect(round1(8.3333)).toBe(8.3)
    expect(round1(66.666)).toBe(66.7)
    expect(round2(4.25)).toBe(4.25)
  })
})

describe('nps', () => {
  it('classifies promoters/passives/detractors', () => {
    const s = nps([10, 9, 8, 7, 6, 0])
    expect(s.n).toBe(6)
    expect(s.promoters).toBe(2) // 10, 9
    expect(s.passives).toBe(2) // 8, 7
    expect(s.detractors).toBe(2) // 6, 0
    expect(s.nps).toBe(0)
  })

  it('all promoters → 100', () => {
    expect(nps([9, 10, 10]).nps).toBe(100)
  })

  it('empty → 0', () => {
    expect(nps([]).nps).toBe(0)
    expect(nps([]).n).toBe(0)
  })
})

describe('csat', () => {
  it('mean and top-box (default ≥4)', () => {
    const s = csat([5, 4, 3, 2, 1])
    expect(s.n).toBe(5)
    expect(s.mean).toBe(3)
    expect(s.topBoxPct).toBe(40) // 5,4 of 5
  })

  it('custom top-box threshold', () => {
    expect(csat([5, 4, 3], { topBoxMin: 5 }).topBoxPct).toBeCloseTo(33.3, 1)
  })

  it('empty → zeros', () => {
    expect(csat([])).toEqual({ n: 0, mean: 0, topBoxPct: 0 })
  })
})

describe('distribution', () => {
  it('counts keys across multi answers', () => {
    const d = distribution([['a', 'b'], ['a'], ['c', 'a']])
    expect(d).toEqual({ a: 3, b: 1, c: 1 })
  })
})
