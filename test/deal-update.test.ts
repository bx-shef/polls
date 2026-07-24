import { describe, expect, it, vi } from 'vitest'
import { runDealUpdate, type DealUpdateDeps } from '../src/bitrix24/deal-update'
import { surveyEventBindParams, SURVEY_DEAL_EVENT } from '../src/bitrix24/install'
import { MemoryInvitationStore } from '../src/api/invitation'
import type { TriggerStore } from '../src/bitrix24/trigger'
import type { CompiledVersion } from '../src/domain/schema'

const ver = (n: number): CompiledVersion => ({ versionNo: n }) as CompiledVersion

/** Мок стора: какие опросы триггерит стадия + текущая версия по ключу (как в trigger.test.ts). */
function store(triggered: Record<string, string[]>, versions: Record<string, number>): TriggerStore {
  return {
    surveysTriggeredBy: async (stageId: string) => triggered[stageId] ?? [],
    currentVersion: async (key: string) => (versions[key] != null ? ver(versions[key]!) : undefined)
  }
}

/** Валидный недоверенный POST ONCRMDEALUPDATE (значения — заведомо фейковые, домен-плейсхолдер). */
const rawEvent = (over: Record<string, unknown> = {}) => ({
  event: 'ONCRMDEALUPDATE',
  data: { FIELDS: { ID: '759' } },
  ts: '1736405807',
  auth: {
    member_id: 'member-id-fake-0000000000000000',
    domain: 'acme.bitrix24.ru',
    application_token: 'app-token-fake-0000000000000000',
    access_token: 'access-token-fake-00000000000000'
  },
  ...over
})

/** Сделка, которую вернёт fetchDeal — стадия `C1:WON` триггерит опрос. */
const dealFields = { ID: '759', STAGE_ID: 'C1:WON', COMPANY_ID: '101', ASSIGNED_BY_ID: '5' }

function deps(over: Partial<DealUpdateDeps> = {}): DealUpdateDeps {
  return {
    storedApplicationToken: async () => 'app-token-fake-0000000000000000', // по умолчанию сходится
    fetchDeal: async () => ({ deal: { ...dealFields }, productRows: [] }),
    store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }),
    invitations: new MemoryInvitationStore(),
    ...over
  }
}

describe('runDealUpdate — авто-триггер ONCRMDEALUPDATE (#17)', () => {
  it('битый/чужой POST → ignored, догрузка сделки НЕ вызывается', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runDealUpdate('мусор', deps({ fetchDeal }))
    expect(res).toEqual({ kind: 'ignored', reason: 'parse' })
    expect(fetchDeal).not.toHaveBeenCalled()

    const notOurEvent = await runDealUpdate(rawEvent({ event: 'ONCRMDEALADD' }), deps({ fetchDeal }))
    expect(notOurEvent.kind).toBe('ignored')
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('портал не установлен (нет сохранённого app_token) → forged/unknown_portal, без догрузки', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runDealUpdate(rawEvent(), deps({ storedApplicationToken: async () => undefined, fetchDeal }))
    expect(res).toEqual({ kind: 'forged', reason: 'unknown_portal' })
    expect(fetchDeal).not.toHaveBeenCalled() // анти-амплификация: подделка не порождает исходящий REST
  })

  it('application_token не сошёлся → forged/token_mismatch, без догрузки', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runDealUpdate(rawEvent(), deps({ storedApplicationToken: async () => 'ДРУГОЙ-токен', fetchDeal }))
    expect(res).toEqual({ kind: 'forged', reason: 'token_mismatch' })
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('токен сошёлся + стадия триггерит опрос → ok, приглашение создано со снимком контекста', async () => {
    const invitations = new MemoryInvitationStore()
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runDealUpdate(rawEvent(), deps({ invitations, fetchDeal }))
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect(res.results).toHaveLength(1)
    expect(res.results[0]).toMatchObject({ surveyKey: 'csat_postdeal', versionNo: 2 })
    // догрузка вызвана с id сделки из события и authoritative member_id (не из body напрямую в trigger)
    expect(fetchDeal).toHaveBeenCalledWith(759, 'member-id-fake-0000000000000000')
    // приглашение реально несёт снимок контекста догруженной сделки
    const inv = invitations.peek(res.results[0]!.token, new Date())
    expect(inv?.context.dealId).toBe(759)
    expect(inv?.context.companyId).toBe(101)
  })

  it('токен сошёлся, но стадия не триггерит ни одного опроса → ok с пустым списком', async () => {
    const res = await runDealUpdate(
      rawEvent(),
      deps({ fetchDeal: async () => ({ deal: { ...dealFields, STAGE_ID: 'C1:NEW' }, productRows: [] }) })
    )
    expect(res).toEqual({ kind: 'ok', results: [] })
  })

  it('товарные позиции догрузки попадают в снимок (срез услуга/товар)', async () => {
    const invitations = new MemoryInvitationStore()
    const res = await runDealUpdate(
      rawEvent(),
      deps({
        invitations,
        fetchDeal: async () => ({
          deal: { ...dealFields },
          productRows: [{ PRODUCT_ID: '42', PRODUCT_NAME: 'Внедрение' }]
        })
      })
    )
    if (res.kind !== 'ok') throw new Error('unreachable')
    const inv = invitations.peek(res.results[0]!.token, new Date())
    expect(inv?.context.products).toEqual([{ productId: 42, productName: 'Внедрение' }])
  })
})

describe('surveyEventBindParams — параметры event.bind (#17)', () => {
  it('ONCRMDEALUPDATE + handler на наш домен', () => {
    expect(surveyEventBindParams('https://polls.example.com/api/b24/deal-update')).toEqual({
      event: SURVEY_DEAL_EVENT,
      handler: 'https://polls.example.com/api/b24/deal-update'
    })
    expect(SURVEY_DEAL_EVENT).toBe('ONCRMDEALUPDATE')
  })
})
