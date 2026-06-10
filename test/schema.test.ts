import { describe, expect, it } from 'vitest'
import { rawAnswerSchema, submissionSchema } from '../src/domain/schema'

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
