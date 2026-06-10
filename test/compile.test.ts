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

  it('падает на пустом surveyKey (zod)', () => {
    expect(() => compile({
      surveyKey: '', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'text', metric: 'text', required: false, text: 'x', options: [] }]
    }, 1)).toThrow()
  })

  it('падает на пустом списке вопросов (zod)', () => {
    expect(() => compile({ surveyKey: 's', title: 't', lang: 'ru', questions: [] }, 1)).toThrow()
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

  it('перестановка вариантов не ломает сопоставимость → unchanged', () => {
    const base: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'choice', required: true, text: 'x', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }]
    }
    const reordered: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'choice', required: true, text: 'x', options: [{ key: 'b', label: 'B' }, { key: 'a', label: 'A' }] }]
    }
    expect(diffVersions(compile(base, 1), compile(reordered, 2))['q']).toBe('unchanged')
  })

  it('смена баллов (score) при тех же ключах → semantic', () => {
    const a: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'nps', required: true, text: 'x', options: [{ key: 'a', label: 'A', score: 1 }] }]
    }
    const b: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'nps', required: true, text: 'x', options: [{ key: 'a', label: 'A', score: 2 }] }]
    }
    expect(diffVersions(compile(a, 1), compile(b, 2))['q']).toBe('semantic')
  })

  it('isComparable: только unchanged/text/options сопоставимы', () => {
    expect(isComparable('unchanged')).toBe(true)
    expect(isComparable('text')).toBe(true)
    expect(isComparable('options')).toBe(true)
    expect(isComparable('semantic')).toBe(false)
    expect(isComparable('added')).toBe(false)
    expect(isComparable('removed')).toBe(false)
  })

  it('смена type (single→multi) при той же метрике → semantic', () => {
    const a: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'choice', required: true, text: 'x', options: [{ key: 'a', label: 'A' }] }]
    }
    const b: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'multi', metric: 'choice', required: true, text: 'x', options: [{ key: 'a', label: 'A' }] }]
    }
    expect(diffVersions(compile(a, 1), compile(b, 2))['q']).toBe('semantic')
  })

  it('появление score у варианта (был без балла) → semantic', () => {
    const a: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'scale', required: true, text: 'x', options: [{ key: 'a', label: 'A' }] }]
    }
    const b: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'scale', required: true, text: 'x', options: [{ key: 'a', label: 'A', score: 5 }] }]
    }
    expect(diffVersions(compile(a, 1), compile(b, 2))['q']).toBe('semantic')
  })
})

describe('compile — параметр at', () => {
  it('compiledAt = переданная дата в ISO', () => {
    const at = new Date('2026-01-02T03:04:05.000Z')
    expect(compile(draftV1(), 1, at).compiledAt).toBe('2026-01-02T03:04:05.000Z')
  })
})

describe('compile — валидация versionNo', () => {
  it('падает на versionNo < 1 и на нецелом', () => {
    expect(() => compile(draftV1(), 0)).toThrow(/положительным/)
    expect(() => compile(draftV1(), 1.5)).toThrow(/положительным/)
  })
})
