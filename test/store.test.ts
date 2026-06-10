import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/memory'
import { draftV1, draftV2, SURVEY_KEY } from '../src/demo/seed'

describe('MemoryStore', () => {
  it('публикует версии и отдаёт их по номеру', async () => {
    const s = new MemoryStore()
    await s.publish(draftV1(), 1)
    await s.publish(draftV2(), 2)
    expect((await s.getVersion(SURVEY_KEY, 1))?.versionNo).toBe(1)
    expect((await s.getVersion(SURVEY_KEY, 2))?.questions.find((q) => q.key === 'q_liked')?.options).toHaveLength(6)
  })

  it('currentVersion возвращает последнюю опубликованную (для пина)', async () => {
    const s = new MemoryStore()
    await s.publish(draftV1(), 1)
    await s.publish(draftV2(), 2)
    expect((await s.currentVersion(SURVEY_KEY))?.versionNo).toBe(2)
  })

  it('повторная публикация версии запрещена (иммутабельность)', async () => {
    const s = new MemoryStore()
    await s.publish(draftV1(), 1)
    await expect(s.publish(draftV1(), 1)).rejects.toThrow(/уже опубликована/)
  })

  it('хранит несколько ответов', async () => {
    const s = new MemoryStore()
    await s.publish(draftV1(), 1)
    await s.addResponse({ id: 'x', surveyKey: SURVEY_KEY, versionNo: 1, submittedAt: '2026-04-01T00:00:00.000Z', context: {}, answers: [] })
    await s.addResponse({ id: 'y', surveyKey: SURVEY_KEY, versionNo: 1, submittedAt: '2026-04-02T00:00:00.000Z', context: {}, answers: [] })
    expect(await s.listResponses()).toHaveLength(2)
  })

  it('пустое хранилище: currentVersion/getVersion → undefined', async () => {
    const s = new MemoryStore()
    expect(await s.currentVersion('nope')).toBeUndefined()
    expect(await s.getVersion('nope', 1)).toBeUndefined()
  })
})
