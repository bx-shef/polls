import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/memory'
import { draftV1, draftV2, SURVEY_KEY } from '../src/demo/seed'

describe('MemoryStore', () => {
  it('публикует версии и отдаёт их по номеру', () => {
    const s = new MemoryStore()
    s.publish(draftV1(), 1)
    s.publish(draftV2(), 2)
    expect(s.getVersion(SURVEY_KEY, 1)?.versionNo).toBe(1)
    expect(s.getVersion(SURVEY_KEY, 2)?.questions.find((q) => q.key === 'q_liked')?.options).toHaveLength(6)
  })

  it('currentVersion возвращает последнюю опубликованную (для пина)', () => {
    const s = new MemoryStore()
    s.publish(draftV1(), 1)
    s.publish(draftV2(), 2)
    expect(s.currentVersion(SURVEY_KEY)?.versionNo).toBe(2)
  })

  it('повторная публикация версии запрещена (иммутабельность)', () => {
    const s = new MemoryStore()
    s.publish(draftV1(), 1)
    expect(() => s.publish(draftV1(), 1)).toThrow(/уже опубликована/)
  })

  it('хранит ответы', () => {
    const s = new MemoryStore()
    s.publish(draftV1(), 1)
    s.addResponse({ id: 'x', surveyKey: SURVEY_KEY, versionNo: 1, submittedAt: '2026-04-01T00:00:00.000Z', context: {}, answers: [] })
    expect(s.responses).toHaveLength(1)
  })
})
