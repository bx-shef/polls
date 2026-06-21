import { describe, expect, it } from 'vitest'
import { compile, diffVersions, isComparable, versionToDraft } from '../src/domain/compile'
import { draftV1, draftV2, CSAT_Q, LIKED_Q, NPS_Q, COMMENT_Q } from '../src/demo/seed'
import { compiledVersionSchema, surveyDraftSchema, type SurveyDraft } from '../src/domain/schema'

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

describe('diffVersions — состав + score одновременно', () => {
  it('добавлен вариант И изменён score у общего ключа → semantic (не options)', () => {
    const a: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'scale', required: true, text: 'x', options: [{ key: 'a', label: 'A', score: 1 }] }]
    }
    const b: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'scale', required: true, text: 'x', options: [{ key: 'a', label: 'A', score: 2 }, { key: 'b', label: 'B', score: 3 }] }]
    }
    expect(diffVersions(compile(a, 1), compile(b, 2))['q']).toBe('semantic')
  })

  it('смена только label (key/score те же) → unchanged', () => {
    const a: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'choice', required: true, text: 'x', options: [{ key: 'a', label: 'Старый' }] }]
    }
    const b: SurveyDraft = {
      surveyKey: 's', title: 't', lang: 'ru',
      questions: [{ key: 'q', type: 'single', metric: 'choice', required: true, text: 'x', options: [{ key: 'a', label: 'Новый' }] }]
    }
    expect(diffVersions(compile(a, 1), compile(b, 2))['q']).toBe('unchanged')
  })
})

describe('compiledVersionSchema — round-trip', () => {
  it('compile(...) проходит собственную схему (включая compiledAt как ISO)', () => {
    expect(compiledVersionSchema.safeParse(compile(draftV1(), 1)).success).toBe(true)
  })
})

describe('versionToDraft — обратная проекция для редактора', () => {
  it('round-trip: compile(draft)→versionToDraft даёт эквивалентный черновик (без versionNo/compiledAt)', () => {
    const draft = surveyDraftSchema.parse(draftV1()) // нормализуем дефолты для сравнения
    const back = versionToDraft(compile(draft, 3))
    expect(back).toEqual(draft)
    expect(back).not.toHaveProperty('versionNo')
    expect(back).not.toHaveProperty('compiledAt')
  })

  it('опрос без invitationPolicy → остаётся undefined (не подставляет дефолт)', () => {
    const back = versionToDraft(compile(draftV1(), 1)) // seed-черновик без политики
    expect(back.invitationPolicy).toBeUndefined()
  })

  it('сохраняет презентацию intro/thanks/blocks', () => {
    const back = versionToDraft(compile(draftV1(), 1))
    expect(back.intro?.title).toBe('Как прошла работа?')
    expect(back.thanks?.title).toBe('Спасибо за ответы!')
  })

  it('сохраняет invitationPolicy (в отличие от публичной проекции)', () => {
    const v = compile(
      {
        surveyKey: 's', title: 't', lang: 'ru',
        questions: [{ key: 'q', type: 'single', metric: 'nps', required: true, text: '?', options: [{ key: 'n10', label: '10', score: 10 }] }],
        invitationPolicy: { entityType: 'spa', spaEntityTypeId: 1056, triggerStages: ['DT1056:WON'], channelOrder: ['email'] }
      },
      1
    )
    expect(versionToDraft(v).invitationPolicy).toMatchObject({ entityType: 'spa', spaEntityTypeId: 1056 })
  })

  it('повторная публикация спроецированного черновика даёт ту же анкету', () => {
    const v1 = compile(draftV2(), 5)
    const republished = compile(versionToDraft(v1), 6)
    // вопросы идентичны → diff целиком unchanged (сопоставимость ряда сохранена)
    expect(Object.values(diffVersions(v1, republished)).every((c) => c === 'unchanged')).toBe(true)
  })
})
