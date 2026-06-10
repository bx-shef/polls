import { describe, expect, it } from 'vitest'
import { compile, diffVersions, isComparable } from '../src/domain/compile'
import { draftV1, draftV2, CSAT_Q, LIKED_Q, NPS_Q, COMMENT_Q } from '../src/demo/seed'
import type { SurveyDraft } from '../src/domain/schema'

describe('compile', () => {
  it('замораживает черновик в версию', () => {
    const v = compile(draftV1(), 1)
    expect(v.versionNo).toBe(1)
    expect(v.surveyKey).toBe('csat_postdeal')
    expect(v.questions).toHaveLength(4)
    expect(typeof v.compiledAt).toBe('string')
  })

  it('падает на дублирующемся question_key', () => {
    const bad: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [
        { key: 'dup', type: 'text', metric: 'text', required: false, text: 'a', options: [] },
        { key: 'dup', type: 'text', metric: 'text', required: false, text: 'b', options: [] }
      ]
    }
    expect(() => compile(bad, 1)).toThrow(/question_key/)
  })

  it('падает на дублирующемся option_key', () => {
    const bad: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [
        {
          key: 'q', type: 'single', metric: 'choice', required: true, text: 'a',
          options: [
            { key: 'o', label: 'A' },
            { key: 'o', label: 'B' }
          ]
        }
      ]
    }
    expect(() => compile(bad, 1)).toThrow(/option_key/)
  })
})

describe('diffVersions', () => {
  it('классифицирует изменения v1→v2 по question_key', () => {
    const d = diffVersions(compile(draftV1(), 1), compile(draftV2(), 2))
    expect(d[NPS_Q]).toBe('unchanged')
    expect(d[CSAT_Q]).toBe('text') // правка формулировки
    expect(d[LIKED_Q]).toBe('options') // добавлен вариант design
    expect(d[COMMENT_Q]).toBe('unchanged')
  })

  it('распознаёт added/removed/semantic', () => {
    const a = compile(
      { surveyKey: 's', title: 't', lang: 'ru', questions: [
        { key: 'keep', type: 'single', metric: 'csat', required: true, text: 'x', options: [{ key: 'a', label: 'A' }] },
        { key: 'gone', type: 'text', metric: 'text', required: false, text: 'y', options: [] }
      ] }, 1)
    const b = compile(
      { surveyKey: 's', title: 't', lang: 'ru', questions: [
        { key: 'keep', type: 'single', metric: 'nps', required: true, text: 'x', options: [{ key: 'a', label: 'A' }] }, // метрика сменилась
        { key: 'fresh', type: 'text', metric: 'text', required: false, text: 'z', options: [] }
      ] }, 2)
    const d = diffVersions(a, b)
    expect(d['keep']).toBe('semantic')
    expect(d['gone']).toBe('removed')
    expect(d['fresh']).toBe('added')
  })

  it('isComparable: только unchanged/text/options сопоставимы', () => {
    expect(isComparable('unchanged')).toBe(true)
    expect(isComparable('text')).toBe(true)
    expect(isComparable('options')).toBe(true)
    expect(isComparable('semantic')).toBe(false)
    expect(isComparable('added')).toBe(false)
    expect(isComparable('removed')).toBe(false)
  })
})
