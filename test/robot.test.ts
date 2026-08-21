import { describe, expect, it, vi } from 'vitest'
import { runRobotTrigger, parseRobotEvent, type RobotDeps } from '../src/bitrix24/robot'
import { parseBracketForm } from '../src/bitrix24/bracket-form'
import { MemoryInvitationStore, type InvitationStore } from '../src/api/invitation'
import type { TriggerStore, TriggerTenant } from '../src/bitrix24/trigger'
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

/** Шим: тесты говорят про `store`/`invitations`, а деп — резолвер тенанта по `member_id` (#49). */
type DepsOver = Omit<Partial<RobotDeps>, 'tenant'> & {
  store?: TriggerStore
  invitations?: InvitationStore
  tenant?: RobotDeps['tenant']
}

function deps(over: DepsOver = {}): RobotDeps {
  const { store: overStore, invitations: overInvitations, tenant: overTenant, ...rest } = over
  const tenant: TriggerTenant = {
    store: overStore ?? store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }),
    invitations: overInvitations ?? new MemoryInvitationStore()
  }
  return {
    storedApplicationToken: async () => 'app-token-fake-0000000000000000',
    fetchDeal: async () => ({ deal: { ...dealFields }, productRows: [] }),
    tenant: overTenant ?? (async () => tenant),
    ...rest
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

  it('капы разбора bracket-формы держатся: много ключей и длинные элементы document_id', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    // кап на число ключей bracket-объекта (иначе раздутое тело заставит нас собирать мусорный массив)
    const manyKeys = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), 'x']))
    // кап на длину одного элемента
    const longItem = ['crm', 'CCrmDocumentDeal', 'D'.repeat(300)]
    for (const d of [manyKeys, longItem, Array.from({ length: 11 }, () => 'x')]) {
      expect((await runRobotTrigger(rawRobot({ document_id: d }), deps({ fetchDeal }))).kind).toBe('ignored')
    }
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('ХАРАКТЕРИЗАЦИЯ: оба пути на одном переходе → ДВА приглашения (осознанный риск режима both)', async () => {
    // Фиксируем ровно тот дефект, который описан в доках: робот срабатывает на входе в стадию, событие
    // приходит тем же изменением и подтверждается историей — на выходе два РАЗНЫХ токена на одну сделку.
    // Тест обязан упасть, когда приедет идемпотентность по ключу перехода, — тогда решение примут явно.
    const { runDealUpdate } = await import('../src/bitrix24/deal-update')
    const invitations = new MemoryInvitationStore()
    const now = new Date('2026-07-31T12:00:00.000Z')
    const r = await runRobotTrigger(rawRobot(), deps({ invitations, now }))
    const e = await runDealUpdate(
      {
        event: 'ONCRMDEALUPDATE',
        data: { FIELDS: { ID: '759' } },
        auth: {
          member_id: 'member-id-fake-0000000000000000',
          domain: 'acme.bitrix24.ru',
          application_token: 'app-token-fake-0000000000000000'
        }
      },
      { ...deps({ invitations, now }), confirmStageEntry: async () => ({ fresh: true }) }
    )
    if (r.kind !== 'ok' || e.kind !== 'ok') throw new Error('unreachable')
    const tokens = new Set([r.results[0]!.token, e.results[0]!.token])
    expect(tokens.size).toBe(2) // ← упадёт, когда появится дедуп по переходу: это и есть цель теста
    expect((await invitations.peek(r.results[0]!.token, now))?.context.dealId).toBe(759)
    expect((await invitations.peek(e.results[0]!.token, now))?.context.dealId).toBe(759)
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
      { ...deps({ invitations: invE, now }), confirmStageEntry: async () => ({ fresh: true }) }
    )
    expect(r.kind === 'ok' && e.kind === 'ok').toBe(true)
    if (r.kind === 'ok' && e.kind === 'ok') {
      expect(r.results.map(({ surveyKey, versionNo }) => ({ surveyKey, versionNo }))).toEqual(
        e.results.map(({ surveyKey, versionNo }) => ({ surveyKey, versionNo }))
      )
      expect((await invR.peek(r.results[0]!.token, now))?.context).toEqual((await invE.peek(e.results[0]!.token, now))?.context)
    }
  })
})

describe('runRobotTrigger — портал выбирается ПОСЛЕ сверки токена (#49)', () => {
  it('токен не сошёлся → тенант НЕ резолвится', async () => {
    const tenant = vi.fn(async () => ({ store: store({}, {}), invitations: new MemoryInvitationStore() }))
    const res = await runRobotTrigger(rawRobot(), deps({ storedApplicationToken: async () => 'другой', tenant }))
    expect(res.kind).toBe('forged')
    expect(tenant).not.toHaveBeenCalled()
  })

  it('портала уже нет → ignored/tenant, догрузки сделки нет', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runRobotTrigger(rawRobot(), deps({ tenant: async () => undefined, fetchDeal }))
    expect(res).toEqual({ kind: 'ignored', reason: 'tenant' })
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('приглашение ложится в стор тенанта, а не в переданный мимо него', async () => {
    const mine = new MemoryInvitationStore()
    const res = await runRobotTrigger(rawRobot(), deps({
      tenant: async () => ({ store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }), invitations: mine })
    }))
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect(await mine.peek(res.results[0]!.token, new Date())).toBeDefined()
  })
})
