import { describe, expect, it } from 'vitest'
import {
  crmContextSchema,
  optionSchema,
  questionSchema,
  rawAnswerSchema,
  responseRecordSchema,
  submissionSchema,
  surveyDraftSchema
} from '../src/domain/schema'

describe('rawAnswerSchema — границы payload', () => {
  it('принимает валидный ответ и пустой объект (вопрос пропущен)', () => {
    expect(rawAnswerSchema.safeParse({ values: ['a'], text: 'hi' }).success).toBe(true)
    expect(rawAnswerSchema.safeParse({}).success).toBe(true)
  })

  it('отклоняет слишком длинный текст (>2000)', () => {
    expect(rawAnswerSchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false)
  })

  it('отклоняет слишком много значений (>100)', () => {
    expect(rawAnswerSchema.safeParse({ values: Array(101).fill('a') }).success).toBe(false)
  })
})

describe('submissionSchema — границы', () => {
  const ok = { surveyKey: 's', versionNo: 1, answers: { q1: { values: ['a'] } } }

  it('принимает валидный сабмишен', () => {
    expect(submissionSchema.safeParse(ok).success).toBe(true)
  })

  it('отклоняет пустой surveyKey', () => {
    expect(submissionSchema.safeParse({ ...ok, surveyKey: '' }).success).toBe(false)
  })

  it('отклоняет отрицательный versionNo', () => {
    expect(submissionSchema.safeParse({ ...ok, versionNo: -1 }).success).toBe(false)
  })

  it('отклоняет слишком много ответов (>200)', () => {
    const answers: Record<string, { values: string[] }> = {}
    for (let i = 0; i < 201; i++) answers[`q${i}`] = { values: ['a'] }
    expect(submissionSchema.safeParse({ ...ok, answers }).success).toBe(false)
  })
})

describe('questionSchema / optionSchema — прямая валидация', () => {
  it('optionSchema: score может быть null', () => {
    expect(optionSchema.safeParse({ key: 'a', label: 'A', score: null }).success).toBe(true)
  })
  it('questionSchema: неизвестная метрика отклоняется', () => {
    expect(questionSchema.safeParse({ key: 'q', type: 'single', metric: 'bad', text: 'x' }).success).toBe(false)
  })
  it('questionSchema: >100 вариантов отклоняется', () => {
    const options = Array.from({ length: 101 }, (_, i) => ({ key: `o${i}`, label: 'x' }))
    expect(questionSchema.safeParse({ key: 'q', type: 'single', metric: 'choice', text: 'x', options }).success).toBe(false)
  })
  it('surveyDraftSchema: >200 вопросов отклоняется', () => {
    const questions = Array.from({ length: 201 }, (_, i) => ({ key: `q${i}`, type: 'text', metric: 'text', text: 'x' }))
    expect(surveyDraftSchema.safeParse({ surveyKey: 's', title: 't', questions }).success).toBe(false)
  })
})

describe('responseRecordSchema — валидация на границе записи', () => {
  const ok = {
    id: 'r1', surveyKey: 's', versionNo: 1, submittedAt: '2026-04-01T10:00:00.000Z',
    context: {}, answers: []
  }
  it('принимает валидную запись и пустой контекст', () => {
    expect(responseRecordSchema.safeParse(ok).success).toBe(true)
  })
  it('отклоняет невалидный submittedAt (не ISO-datetime)', () => {
    expect(responseRecordSchema.safeParse({ ...ok, submittedAt: '2026-04-01' }).success).toBe(false)
  })
  it('crmContext с числовыми id валиден', () => {
    expect(crmContextSchema.safeParse({ companyId: 5, dealId: 9, products: [{ productId: 1 }] }).success).toBe(true)
  })
})
