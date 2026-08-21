import { describe, expect, it, vi } from 'vitest'
import { runRobotTrigger, parseRobotEvent, robotTransition, ROBOT_TS_SKEW_MS, type RobotDeps } from '../src/bitrix24/robot'
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
  if (overTenant && (overStore || overInvitations)) {
    throw new Error('deps(): tenant задан вместе со store/invitations — они бы никуда не поехали')
  }
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

  it('тенант резолвится по ПОДТВЕРЖДЁННОМУ member_id, и приглашение ложится в его стор', async () => {
    // ⚠️ Аргумент резолвера сверяем поимённо: `deps.tenant('')` вместо `deps.tenant(member_id)`
    // выглядит рабочим кодом и делает робота молча мёртвым — каждый эвент даёт `ignored/tenant`.
    const mine = new MemoryInvitationStore()
    const tenant = vi.fn(async (_memberId: string) => ({
      store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }), invitations: mine
    }))
    const res = await runRobotTrigger(rawRobot(), deps({ tenant }))
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect(tenant).toHaveBeenCalledWith('member-id-fake-0000000000000000')
    expect(await mine.peek(res.results[0]!.token, new Date())).toBeDefined()
  })
})

describe('robotTransition — ключ перехода для робота (#175)', () => {
  const now = new Date('2026-08-21T10:00:00.000Z')
  const nowSec = Math.floor(now.getTime() / 1000)

  it('часы портала правдоподобны → ключ и момент берутся из них', () => {
    const portalSec = nowSec - 5
    const t = robotTransition(String(portalSec), now)
    expect(t.id).toBe(`robot-${portalSec}`)
    expect(t.at.toISOString()).toBe(new Date(portalSec * 1000).toISOString())
  })

  it('число вместо строки принимается так же (wire-формат бывает разным)', () => {
    expect(robotTransition(nowSec, now).id).toBe(`robot-${nowSec}`)
  })

  it('ПОВТОРНЫЙ вызов с тем же ts даёт ТОТ ЖЕ ключ — повтор bizproc не плодит дело', () => {
    // Ключ из момента СРАБАТЫВАНИЯ, а не из наших часов, именно поэтому: повтор вызова роботом
    // должен упереться в поиск по маркеру, а не создать второе дело. На своих часах два вызова,
    // разошедшиеся на секунду, дали бы РАЗНЫЕ ключи — и дубль.
    const portalSec = String(nowSec - 3)
    const a = robotTransition(portalSec, now)
    const b = robotTransition(portalSec, new Date(now.getTime() + 900))
    expect(a.id).toBe(b.id)
  })

  it('другой переход (другая секунда) → ДРУГОЙ ключ: возврат в стадию — законный повод спросить', () => {
    expect(robotTransition(String(nowSec), now).id).not.toBe(robotTransition(String(nowSec - 1), now).id)
  })

  for (const [name, ts] of [
    ['мусор', 'позавчера'], ['пусто', ''], ['нет поля', undefined],
    ['ноль', '0'], ['отрицательное', '-5'], ['дробное', '1.5'], ['миллисекунды вместо секунд', String(nowSec * 1000)]
  ] as const) {
    it(`негодный ts (${name}) → берём СВОИ часы, а не то, что прислали`, () => {
      const t = robotTransition(ts, now)
      expect(t.id).toBe(`robot-${nowSec}`)
      expect(t.at.getTime()).toBe(now.getTime())
    })
  }

  it('часы портала уехали больше чем на сутки → берём свои', () => {
    // ⚠️ Несущее: `at` решает «отвечал ли клиент ПОСЛЕ этого перехода». Момент из далёкого прошлого
    // заставил бы прошлогодний ответ погасить сегодняшний повод спросить — приглашение молча не
    // выписалось бы, и снаружи это неотличимо от «робот не сработал».
    const stale = Math.floor((now.getTime() - ROBOT_TS_SKEW_MS - 1000) / 1000)
    expect(robotTransition(String(stale), now).id).toBe(`robot-${nowSec}`)
    const future = Math.floor((now.getTime() + ROBOT_TS_SKEW_MS + 1000) / 1000)
    expect(robotTransition(String(future), now).id).toBe(`robot-${nowSec}`)
  })

  it('ключ не содержит двоеточий — иначе маркер перестанет разбираться', () => {
    // `markerMatchesSurvey` режет `stage:<переход>:<опрос>` по ВТОРОМУ двоеточию: лишнее в ключе
    // перехода означало бы, что мы перестали узнавать свои же дела, и закрытие ответом молча умерло.
    expect(robotTransition(String(nowSec), now).id).not.toContain(':')
  })
})

describe('runRobotTrigger — доставка приглашения (#175)', () => {
  it('выписка идёт через `issue` (дело в таймлайне), а не в фолбэк «только токен»', async () => {
    // Ровно тот дефект, ради которого задача: без `issue` приглашение появлялось в базе, дела не
    // было, и сотрудник ссылку не видел.
    type IssueCtx = { transition: { id?: string; at?: Date }; memberId: string }
    const issue = vi.fn((_ctx: IssueCtx) => async () => ({ surveyKey: 'csat_postdeal', versionNo: 2, token: 'tk' }))
    // ⚠️ `ts` берём близким к настоящим часам: значение из прошлого сработала бы проверка
    // правдоподобия, и тест доказывал бы её, а не проводку выписки.
    const ts = String(Math.floor(Date.now() / 1000) - 2)
    const res = await runRobotTrigger(rawRobot({ ts }), deps({ issue }))
    expect(res.kind).toBe('ok')
    expect(issue).toHaveBeenCalledTimes(1)
    const ctx = issue.mock.calls[0]![0]
    expect(ctx.transition.id).toBe(`robot-${ts}`)
    expect(ctx.memberId).toBe('member-id-fake-0000000000000000')
  })

  it('отказ выписки по ОДНОМУ опросу не роняет вызов и доезжает в лог', async () => {
    const onIssueError = vi.fn()
    const res = await runRobotTrigger(rawRobot(), deps({
      issue: () => async () => { throw new Error('портал недоступен') },
      onIssueError
    }))
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect(res.results).toEqual([])
    expect(onIssueError).toHaveBeenCalledWith('csat_postdeal', expect.any(Error))
  })
})
