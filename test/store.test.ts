import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/memory'
import { draftV1, draftV2, SURVEY_KEY } from '../src/demo/seed'
import type { ResponseRecord } from '../src/domain/schema'

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

  it('listSurveys — пустой стор → []', async () => {
    expect(await new MemoryStore().listSurveys()).toEqual([])
  })

  it('listSurveys — сводка по текущей версии (back-compat: без политики → undefined/[])', async () => {
    const s = new MemoryStore()
    await s.publish(draftV1(), 1)
    await s.publish(draftV2(), 2)
    const list = await s.listSurveys()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ surveyKey: SURVEY_KEY, currentVersionNo: 2, triggerStages: [] })
    expect(list[0]!.entityType).toBeUndefined()
  })

  it('listSurveys — сортировка по survey_key (вставка не по алфавиту)', async () => {
    const s = new MemoryStore()
    const mini = (key: string) => ({
      surveyKey: key, title: key, lang: 'ru',
      questions: [{ key: 'q', type: 'text' as const, metric: 'text' as const, required: true, text: '?', options: [] }]
    })
    await s.publish(mini('zebra'), 1)
    await s.publish(mini('alpha'), 1)
    await s.publish(mini('mike'), 1)
    expect((await s.listSurveys()).map((x) => x.surveyKey)).toEqual(['alpha', 'mike', 'zebra'])
  })

  it('listSurveys — привязка-датчик из текущей версии (entityType/spaEntityTypeId/triggerStages)', async () => {
    const s = new MemoryStore()
    await s.publish(
      {
        surveyKey: 'spa_nps',
        title: 'NPS по смарт-процессу',
        lang: 'ru',
        questions: [{ key: 'q', type: 'single', metric: 'nps', required: true, text: '?', options: [{ key: 'n10', label: '10', score: 10 }] }],
        invitationPolicy: { entityType: 'spa', spaEntityTypeId: 1056, triggerStages: ['DT1056:WON'], channelOrder: ['email'] }
      },
      1
    )
    const summary = (await s.listSurveys()).find((x) => x.surveyKey === 'spa_nps')
    expect(summary).toMatchObject({ entityType: 'spa', spaEntityTypeId: 1056, triggerStages: ['DT1056:WON'] })
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

  it('ping() — health-проба in-memory резолвится (#5)', async () => {
    await expect(new MemoryStore().ping()).resolves.toBeUndefined()
  })

  it('listResponses фильтрует по surveyKey, разные опросы не смешиваются', async () => {
    const s = new MemoryStore()
    await s.addResponse({ id: 'a1', surveyKey: 'A', versionNo: 1, submittedAt: '2026-04-01T10:00:00.000Z', context: {}, answers: [] })
    await s.addResponse({ id: 'b1', surveyKey: 'B', versionNo: 1, submittedAt: '2026-04-02T10:00:00.000Z', context: {}, answers: [] })
    expect(await s.listResponses()).toHaveLength(2)
    expect((await s.listResponses('A')).map((r) => r.id)).toEqual(['a1'])
    expect((await s.listResponses('B')).map((r) => r.id)).toEqual(['b1'])
  })

  it('addResponse отклоняет невалидный submittedAt', async () => {
    const s = new MemoryStore()
    await expect(
      s.addResponse({ id: 'x', surveyKey: 'A', versionNo: 1, submittedAt: 'не дата', context: {}, answers: [] })
    ).rejects.toThrow()
  })

  it('addResponse отклоняет невалидный metric в ответе', async () => {
    const s = new MemoryStore()
    await expect(
      s.addResponse({
        id: 'x', surveyKey: 'A', versionNo: 1, submittedAt: '2026-04-01T10:00:00.000Z', context: {},
        answers: [{ questionKey: 'q', metric: 'bad' as never, valueChoice: [], valueNumber: null, valueText: null }]
      })
    ).rejects.toThrow()
  })

  it('идемпотентность по invitationToken: повтор токена → no-op; без токена дедупа нет (#3/#4)', async () => {
    const s = new MemoryStore()
    const mk = (id: string, over: Partial<ResponseRecord> = {}): ResponseRecord => ({
      id, surveyKey: 'A', versionNo: 1, submittedAt: '2026-04-01T10:00:00.000Z', context: {}, answers: [], ...over
    })
    await s.addResponse(mk('a', { invitationToken: 'tok-1' }))
    await s.addResponse(mk('b', { invitationToken: 'tok-1' })) // повтор → no-op
    const after = await s.listResponses()
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe('a') // сохранён первый, не перезаписан вторым
    await s.addResponse(mk('c', { invitationToken: 'tok-2' })) // другой токен → пишется
    expect(await s.listResponses()).toHaveLength(2)
    await s.addResponse(mk('d')) // без токена — дедупа нет
    await s.addResponse(mk('e'))
    const all = await s.listResponses()
    expect(all).toHaveLength(4)
    expect(all.filter((r) => r.invitationToken == null)).toHaveLength(2) // d, e — без токена
  })

  it('listResponses возвращает копию — мутация не утекает в стор', async () => {
    const s = new MemoryStore()
    await s.addResponse({ id: 'a1', surveyKey: 'A', versionNo: 1, submittedAt: '2026-04-01T10:00:00.000Z', context: {}, answers: [] })
    const list = await s.listResponses()
    list.push({ ...list[0]!, id: 'fake' })
    expect(await s.listResponses()).toHaveLength(1)
  })
})

describe('MemoryStore.listResponsesPage (keyset-пагинация)', () => {
  const mk = (id: string, date: string, sk = 'A'): ResponseRecord => ({
    id, surveyKey: sk, versionNo: 1, submittedAt: `${date}T10:00:00.000Z`, context: {}, answers: []
  })

  it('страницы по 2 с курсором; тай-брейк по id при равном времени', async () => {
    const s = new MemoryStore()
    // вставка не по порядку — сортировка должна привести к [a, b, c]
    await s.addResponse(mk('c', '2026-04-02'))
    await s.addResponse(mk('a', '2026-04-01'))
    await s.addResponse(mk('b', '2026-04-01')) // тот же timestamp, что 'a' → тай-брейк по id
    const p1 = await s.listResponsesPage({ limit: 2 })
    expect(p1.items.map((r) => r.id)).toEqual(['a', 'b'])
    expect(p1.nextCursor).toBeTruthy()
    const p2 = await s.listResponsesPage({ limit: 2, cursor: p1.nextCursor })
    expect(p2.items.map((r) => r.id)).toEqual(['c'])
    expect(p2.nextCursor).toBeUndefined()
  })

  it('дефолтный лимит и фильтр по surveyKey', async () => {
    const s = new MemoryStore()
    await s.addResponse(mk('a', '2026-04-01', 'A'))
    await s.addResponse(mk('b', '2026-04-02', 'B'))
    const page = await s.listResponsesPage()
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeUndefined()
    expect((await s.listResponsesPage({ surveyKey: 'A' })).items.map((r) => r.id)).toEqual(['a'])
  })

  it('тай-брейк по числовому id корректен (r2 < r10, не лексикографически)', async () => {
    const s = new MemoryStore()
    await s.addResponse(mk('r10', '2026-04-01'))
    await s.addResponse(mk('r2', '2026-04-01'))
    expect((await s.listResponsesPage({ limit: 10 })).items.map((r) => r.id)).toEqual(['r2', 'r10'])
  })

  it('лимит клампится (0 → ≥1, огромный → ≤ MAX)', async () => {
    const s = new MemoryStore()
    await s.addResponse(mk('a', '2026-04-01'))
    await s.addResponse(mk('b', '2026-04-02'))
    expect((await s.listResponsesPage({ limit: 0 })).items).toHaveLength(1)
    expect((await s.listResponsesPage({ limit: 9999 })).items).toHaveLength(2)
  })
})
