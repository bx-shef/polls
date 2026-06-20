import { describe, expect, it } from 'vitest'
import { handleDealTrigger, dealIdFromDocumentId, type TriggerStore } from '../src/bitrix24/trigger'
import { MemoryInvitationStore } from '../src/api/invitation'
import type { CompiledVersion, CrmContext } from '../src/domain/schema'

const ctx = (over: Partial<CrmContext> = {}): CrmContext => ({ dealId: 759, dealStageId: 'C1:WON', ...over })
const ver = (n: number): CompiledVersion => ({ versionNo: n }) as CompiledVersion

/** Мок стора: какие опросы триггерит стадия + текущая версия по ключу. */
function store(triggered: Record<string, string[]>, versions: Record<string, number>): TriggerStore {
  return {
    surveysTriggeredBy: async (stageId: string) => triggered[stageId] ?? [],
    currentVersion: async (key: string) => (versions[key] != null ? ver(versions[key]!) : undefined)
  }
}

describe('handleDealTrigger — стадия → приглашения (#17)', () => {
  it('опрос триггерится стадией → создаётся приглашение с контекстом и токеном', async () => {
    const invitations = new MemoryInvitationStore()
    const res = await handleDealTrigger({
      store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }),
      invitations,
      context: ctx()
    })
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ surveyKey: 'csat_postdeal', versionNo: 2 })
    expect(res[0]!.token).toBeTruthy()
    // приглашение реально создано: peek по токену отдаёт снимок контекста
    const inv = invitations.peek(res[0]!.token, new Date())
    expect(inv?.context.dealId).toBe(759)
    expect(inv?.surveyKey).toBe('csat_postdeal')
  })

  it('несколько опросов на стадию → несколько приглашений', async () => {
    const res = await handleDealTrigger({
      store: store({ 'C1:WON': ['a', 'b'] }, { a: 1, b: 3 }),
      invitations: new MemoryInvitationStore(),
      context: ctx()
    })
    expect(res.map((r) => r.surveyKey)).toEqual(['a', 'b'])
    expect(res.map((r) => r.versionNo)).toEqual([1, 3])
  })

  it('нет стадии в контексте → пусто (триггерить нечего)', async () => {
    const res = await handleDealTrigger({
      store: store({ 'C1:WON': ['a'] }, { a: 1 }),
      invitations: new MemoryInvitationStore(),
      context: ctx({ dealStageId: undefined })
    })
    expect(res).toEqual([])
  })

  it('стадия не триггерит ни одного опроса → пусто', async () => {
    const res = await handleDealTrigger({
      store: store({ 'C1:WON': ['a'] }, { a: 1 }),
      invitations: new MemoryInvitationStore(),
      context: ctx({ dealStageId: 'C1:NEW' })
    })
    expect(res).toEqual([])
  })

  it('опрос без опубликованной версии → пропускается (не падает)', async () => {
    const res = await handleDealTrigger({
      store: store({ 'C1:WON': ['ghost'] }, {}), // currentVersion вернёт undefined
      invitations: new MemoryInvitationStore(),
      context: ctx()
    })
    expect(res).toEqual([])
  })
})

describe('dealIdFromDocumentId — document_id робота (#17)', () => {
  it('crm DEAL → числовой id', () => {
    expect(dealIdFromDocumentId(['crm', 'CCrmDocumentDeal', 'DEAL_759'])).toBe(759)
  })
  it('не сделка / мусор / не массив → undefined', () => {
    expect(dealIdFromDocumentId(['crm', 'CCrmDocumentLead', 'LEAD_12'])).toBeUndefined()
    expect(dealIdFromDocumentId(['crm', 'CCrmDocumentDeal', 'DEAL_0'])).toBeUndefined()
    expect(dealIdFromDocumentId(['crm', 'CCrmDocumentDeal', 'DEAL_x'])).toBeUndefined()
    expect(dealIdFromDocumentId('DEAL_5')).toBeUndefined()
    expect(dealIdFromDocumentId([])).toBeUndefined()
  })
})
