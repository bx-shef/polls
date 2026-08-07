import { describe, expect, it, vi } from 'vitest'
import { runRobotTrigger, parseRobotEvent, type RobotDeps } from '../src/bitrix24/robot'
import { parseBracketForm } from '../src/bitrix24/bracket-form'
import { MemoryInvitationStore } from '../src/api/invitation'
import type { TriggerStore } from '../src/bitrix24/trigger'
import type { CompiledVersion } from '../src/domain/schema'

const ver = (n: number): CompiledVersion => ({ versionNo: n }) as CompiledVersion

function store(triggered: Record<string, string[]>, versions: Record<string, number>): TriggerStore {
  return {
    surveysTriggeredBy: async (stageId: string) => triggered[stageId] ?? [],
    currentVersion: async (key: string) => (versions[key] != null ? ver(versions[key]!) : undefined)
  }
}

/** Валидный недоверенный POST робота (значения заведомо фейковые). */
const rawRobot = (over: Record<string, unknown> = {}) => ({
  code: 'survey_launch',
  document_id: ['crm', 'CCrmDocumentDeal', 'DEAL_759'],
  ts: '1736405807',
  auth: {
    member_id: 'member-id-fake-0000000000000000',
    application_token: 'app-token-fake-0000000000000000'
  },
  ...over
})

const dealFields = { ID: '759', STAGE_ID: 'C1:WON', COMPANY_ID: '101' }

function deps(over: Partial<RobotDeps> = {}): RobotDeps {
  return {
    storedApplicationToken: async () => 'app-token-fake-0000000000000000',
    fetchDeal: async () => ({ deal: { ...dealFields }, productRows: [] }),
    store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }),
    invitations: new MemoryInvitationStore(),
    ...over
  }
}

describe('parseRobotEvent — разбор POST робота (#122)', () => {
  it('валидный payload → document_id + auth', () => {
    const ev = parseRobotEvent(rawRobot())
    expect(ev?.document_id).toEqual(['crm', 'CCrmDocumentDeal', 'DEAL_759'])
    expect(ev?.auth.member_id).toBe('member-id-fake-0000000000000000')
  })

  it('мусор/неполнота → null', () => {
    expect(parseRobotEvent('мусор')).toBeNull()
    expect(parseRobotEvent({})).toBeNull()
    expect(parseRobotEvent(rawRobot({ auth: { member_id: 'm' } }))).toBeNull() // нет application_token
    expect(parseRobotEvent(rawRobot({ document_id: [] }))).toBeNull()
  })

  it('переживает bracket-форму Bitrix (плоские ключи → вложенный объект)', () => {
    // Робот шлёт form-urlencoded; Nitro отдаёт плоскую карту ключей, её разбирает parseBracketForm
    const flat = {
      'document_id[0]': 'crm',
      'document_id[1]': 'CCrmDocumentDeal',
      'document_id[2]': 'DEAL_759',
      'auth[member_id]': 'member-id-fake-0000000000000000',
      'auth[application_token]': 'app-token-fake-0000000000000000',
      code: 'survey_launch'
    }
    // ⚠️ ключевой кейс: parseBracketForm отдаёт document_id ОБЪЕКТОМ {0:…,1:…,2:…}, не массивом —
    // схема, ждущая массив, отвергла бы реальный POST и робот молча не работал бы (см. toStringArray)
    const parsed = parseBracketForm(flat)
    expect(Array.isArray((parsed as { document_id?: unknown }).document_id)).toBe(false)
    const ev = parseRobotEvent(parsed)
    expect(ev?.document_id).toEqual(['crm', 'CCrmDocumentDeal', 'DEAL_759'])
    expect(ev?.auth.application_token).toBe('app-token-fake-0000000000000000')
  })

  it('порядок восстанавливается по числовому ключу, а не по порядку вставки', () => {
    const ev = parseRobotEvent({
      document_id: { '2': 'DEAL_759', '0': 'crm', '1': 'CCrmDocumentDeal' },
      auth: { member_id: 'm', application_token: 't' }
    })
    expect(ev?.document_id).toEqual(['crm', 'CCrmDocumentDeal', 'DEAL_759'])
  })
})

describe('runRobotTrigger — робот автоматизации «Запустить опрос» (#122)', () => {
  it('валидный вызов на триггер-стадии → приглашение выписано', async () => {
    const res = await runRobotTrigger(rawRobot(), deps())
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.dealId).toBe(759)
      expect(res.results).toHaveLength(1)
      expect(res.results[0]).toMatchObject({ surveyKey: 'csat_postdeal', versionNo: 2 })
    }
  })

  it('НЕ требует подтверждения истории стадий (робот и так на входе в стадию)', async () => {
    // в отличие от deal-update, у робота нет confirmStageEntry — сделка, давно стоящая в стадии,
    // всё равно даст приглашение, потому что робот вызывается автоматизацией именно при входе
    const res = await runRobotTrigger(rawRobot(), deps())
    expect(res.kind).toBe('ok')
  })

  it('битый POST → ignored, догрузка сделки НЕ вызывается', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    expect(await runRobotTrigger('мусор', deps({ fetchDeal }))).toEqual({ kind: 'ignored', reason: 'parse' })
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('робот повешен на не-сделку → ignored (not_deal), без исходящих вызовов', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runRobotTrigger(rawRobot({ document_id: ['crm', 'CCrmDocumentLead', 'LEAD_12'] }), deps({ fetchDeal }))
    expect(res).toEqual({ kind: 'ignored', reason: 'not_deal' })
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('подделка токена → forged, догрузка сделки НЕ вызывается (анти-амплификация)', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runRobotTrigger(rawRobot(), deps({ storedApplicationToken: async () => 'ДРУГОЙ', fetchDeal }))
    expect(res).toMatchObject({ kind: 'forged', reason: 'token_mismatch' })
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('портал не установлен → forged/unknown_portal', async () => {
    const res = await runRobotTrigger(rawRobot(), deps({ storedApplicationToken: async () => undefined }))
    expect(res).toMatchObject({ kind: 'forged', reason: 'unknown_portal' })
  })

  it('стадия не триггерит опросы → ok с пустым списком', async () => {
    const res = await runRobotTrigger(rawRobot(), deps({ store: store({ 'C1:LOSE': ['x'] }, { x: 1 }) }))
    expect(res).toEqual({ kind: 'ok', results: [], dealId: 759 })
  })

  it('непригодный document_id (не-строки, мусор, пусто) → ignored, без исходящих вызовов', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    for (const d of [{}, { foo: 'bar' }, ['crm', 'CCrmDocumentDeal', 123], { 0: 'crm', 1: 99 }]) {
      const res = await runRobotTrigger(rawRobot({ document_id: d }), deps({ fetchDeal }))
      expect(res.kind).toBe('ignored')
    }
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('чрезмерно длинные значения отвергаются (тело недоверенное, разбор ДО сверки токена)', async () => {
    const long = 'x'.repeat(500)
    expect(await runRobotTrigger(rawRobot({ auth: { member_id: long, application_token: 't' } }), deps())).toEqual({
      kind: 'ignored',
      reason: 'parse'
    })
  })

  it('паритет с событийным путём: одна сделка → тот же опрос/версия и тот же снимок контекста', async () => {
    // два оркестратора дублируют dealToCrmContext + handleDealTrigger; расхождение поймается здесь
    const { runDealUpdate } = await import('../src/bitrix24/deal-update')
    const invR = new MemoryInvitationStore()
    const invE = new MemoryInvitationStore()
    const now = new Date('2026-07-31T12:00:00.000Z')
    const r = await runRobotTrigger(rawRobot(), deps({ invitations: invR, now }))
    const e = await runDealUpdate(
      {
        event: 'ONCRMDEALUPDATE',
        data: { FIELDS: { ID: '759' } },
        auth: { member_id: 'member-id-fake-0000000000000000', domain: 'acme.bitrix24.ru', application_token: 'app-token-fake-0000000000000000' }
      },
      { ...deps({ invitations: invE, now }), confirmStageEntry: async () => true }
    )
    expect(r.kind === 'ok' && e.kind === 'ok').toBe(true)
    if (r.kind === 'ok' && e.kind === 'ok') {
      expect(r.results.map(({ surveyKey, versionNo }) => ({ surveyKey, versionNo }))).toEqual(
        e.results.map(({ surveyKey, versionNo }) => ({ surveyKey, versionNo }))
      )
      expect(invR.peek(r.results[0]!.token, now)?.context).toEqual(invE.peek(e.results[0]!.token, now)?.context)
    }
  })
})
