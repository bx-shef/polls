import { describe, expect, it } from 'vitest'
import { handleDealTrigger, createSurveyInvitation, dealIdFromDocumentId, type TriggerStore } from '../src/bitrix24/trigger'
import { MemoryInvitationStore, type InvitationCreate, type InvitationStore } from '../src/api/invitation'
import type { CompiledVersion, CrmContext, InvitationPolicy } from '../src/domain/schema'

const ctx = (over: Partial<CrmContext> = {}): CrmContext => ({ dealId: 759, dealStageId: 'C1:WON', ...over })
const ver = (n: number): CompiledVersion => ({ versionNo: n }) as CompiledVersion
/** Версия с политикой приглашения (для проверки проводки срока доступности ссылки). */
const verWithPolicy = (n: number, policy: Partial<InvitationPolicy>): CompiledVersion =>
  ({ versionNo: n, invitationPolicy: { entityType: 'deal', triggerStages: [], channelOrder: ['email', 'sms'], ...policy } }) as CompiledVersion
/** Стор, отдающий готовые CompiledVersion (с политикой) — в отличие от `store()` выше, что строит `ver()`. */
function storeV(triggered: Record<string, string[]>, versions: Record<string, CompiledVersion>): TriggerStore {
  return {
    surveysTriggeredBy: async (stageId: string) => triggered[stageId] ?? [],
    currentVersion: async (key: string) => versions[key]
  }
}
/** Живой срок приглашения (мс) = expiresAt − createdAt из снимка приглашения. */
const windowMs = (inv: { createdAt: string; expiresAt?: string }): number =>
  new Date(inv.expiresAt!).getTime() - new Date(inv.createdAt).getTime()

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
    const { created: res } = await handleDealTrigger({
      store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }),
      invitations,
      context: ctx()
    })
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ surveyKey: 'csat_postdeal', versionNo: 2 })
    expect(res[0]!.token).toBeTruthy()
    // приглашение реально создано: peek по токену отдаёт снимок контекста
    const inv = await invitations.peek(res[0]!.token, new Date())
    expect(inv?.context.dealId).toBe(759)
    expect(inv?.surveyKey).toBe('csat_postdeal')
  })

  it('несколько опросов на стадию → несколько приглашений', async () => {
    const { created: res } = await handleDealTrigger({
      store: store({ 'C1:WON': ['a', 'b'] }, { a: 1, b: 3 }),
      invitations: new MemoryInvitationStore(),
      context: ctx()
    })
    expect(res.map((r) => r.surveyKey)).toEqual(['a', 'b'])
    expect(res.map((r) => r.versionNo)).toEqual([1, 3])
  })

  it('нет стадии в контексте → пусто (триггерить нечего)', async () => {
    const { created: res } = await handleDealTrigger({
      store: store({ 'C1:WON': ['a'] }, { a: 1 }),
      invitations: new MemoryInvitationStore(),
      context: ctx({ dealStageId: undefined })
    })
    expect(res).toEqual([])
  })

  it('стадия не триггерит ни одного опроса → пусто', async () => {
    const { created: res } = await handleDealTrigger({
      store: store({ 'C1:WON': ['a'] }, { a: 1 }),
      invitations: new MemoryInvitationStore(),
      context: ctx({ dealStageId: 'C1:NEW' })
    })
    expect(res).toEqual([])
  })

  it('опрос без опубликованной версии → пропускается (не падает)', async () => {
    const { created: res } = await handleDealTrigger({
      store: store({ 'C1:WON': ['ghost'] }, {}), // currentVersion вернёт undefined
      invitations: new MemoryInvitationStore(),
      context: ctx()
    })
    expect(res).toEqual([])
  })
})

describe('createSurveyInvitation — ручной запуск по сделке (#17)', () => {
  it('опубликованная версия → приглашение с контекстом', async () => {
    const invitations = new MemoryInvitationStore()
    const res = await createSurveyInvitation({
      store: store({}, { csat_postdeal: 2 }),
      invitations,
      surveyKey: 'csat_postdeal',
      context: ctx()
    })
    expect(res).toMatchObject({ surveyKey: 'csat_postdeal', versionNo: 2 })
    expect((await invitations.peek(res!.token, new Date()))?.context.dealId).toBe(759)
  })
  it('боевой путь НЕ назначает токен сам — его генерирует стор', async () => {
    // ⚠️ Гард к полю `InvitationCreate.token` (оно заведено ради демо-засева с известной ссылкой).
    // Ровно это поле и есть «возможность назначить чужой токен», если её однажды дотянут до тела
    // запроса. Проверяем ИСПОЛНЕНИЕМ обоих боевых строителей: поля в аргументе быть не должно.
    const seen: InvitationCreate[] = []
    const spy: InvitationStore = {
      create: async (input, now) => {
        seen.push(input)
        return new MemoryInvitationStore().create(input, now)
      },
      peek: async () => undefined,
      consume: async () => ({ status: 'unknown' })
    }
    await createSurveyInvitation({ store: store({}, { csat_postdeal: 2 }), invitations: spy, surveyKey: 'csat_postdeal', context: ctx() })
    await handleDealTrigger({
      store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }),
      invitations: spy,
      context: ctx()
    })
    expect(seen.length, 'ни один строитель не позван — гард ничего не проверяет').toBe(2)
    for (const input of seen) {
      expect(Object.keys(input), 'боевой вызов задал токен явно').not.toContain('token')
    }
  })

  it('нет опубликованной версии → null', async () => {
    const res = await createSurveyInvitation({
      store: store({}, {}),
      invitations: new MemoryInvitationStore(),
      surveyKey: 'ghost',
      context: ctx()
    })
    expect(res).toBeNull()
  })
})

describe('срок доступности ссылки → ttl приглашения (linkTtlSeconds, Цикл 2)', () => {
  const now = new Date('2026-07-24T10:00:00.000Z')

  it('handleDealTrigger: linkTtlSeconds=300 → окно ссылки ровно 5 минут', async () => {
    const invitations = new MemoryInvitationStore()
    const { created: res } = await handleDealTrigger({
      store: storeV({ 'C1:WON': ['s'] }, { s: verWithPolicy(1, { linkTtlSeconds: 300 }) }),
      invitations,
      context: ctx(),
      now
    })
    expect(windowMs((await invitations.peek(res[0]!.token, now))!)).toBe(300_000)
  })

  it('createSurveyInvitation: linkTtlSeconds=432000 → окно ссылки ровно 5 дней', async () => {
    const invitations = new MemoryInvitationStore()
    const res = await createSurveyInvitation({
      store: storeV({}, { s: verWithPolicy(1, { linkTtlSeconds: 432000 }) }),
      invitations,
      surveyKey: 's',
      context: ctx(),
      now
    })
    expect(windowMs((await invitations.peek(res!.token, now))!)).toBe(432_000_000)
  })

  it('политика без linkTtlSeconds → дефолт стора приглашений (back-compat)', async () => {
    const invitations = new MemoryInvitationStore({ ttlMs: 7_000 })
    const res = await createSurveyInvitation({
      store: storeV({}, { s: verWithPolicy(1, {}) }),
      invitations,
      surveyKey: 's',
      context: ctx(),
      now
    })
    expect(windowMs((await invitations.peek(res!.token, now))!)).toBe(7_000)
  })

  it('версия вообще без invitationPolicy → тоже дефолт стора', async () => {
    const invitations = new MemoryInvitationStore({ ttlMs: 7_000 })
    const res = await createSurveyInvitation({
      store: store({}, { s: 1 }), // ver() без политики
      invitations,
      surveyKey: 's',
      context: ctx(),
      now
    })
    expect(windowMs((await invitations.peek(res!.token, now))!)).toBe(7_000)
  })

  it('linkTtlSeconds=300 → после 301с ссылка недоступна (peek undefined, consume unknown = 403 на submit)', async () => {
    // Дефолт стора большой (30д) — истекает именно per-invite ttl из linkTtlSeconds, а не дефолт.
    // Замыкает продуктовый инвариант «после истечения ссылка не принимает ответ» end-to-end (consume→unknown→403).
    const invitations = new MemoryInvitationStore()
    const res = await createSurveyInvitation({
      store: storeV({}, { s: verWithPolicy(1, { linkTtlSeconds: 300 }) }),
      invitations,
      surveyKey: 's',
      context: ctx(),
      now
    })
    const after = new Date(now.getTime() + 301_000)
    expect(await invitations.peek(res!.token, after)).toBeUndefined()
    expect(await invitations.consume(res!.token, { surveyKey: 's', versionNo: 1 }, after)).toEqual({ status: 'unknown' })
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
