import { describe, expect, it, vi } from 'vitest'
import { runDealUpdate, type DealUpdateDeps } from '../src/bitrix24/deal-update'
import { parseBracketForm } from '../src/bitrix24/bracket-form'
import { surveyEventBindParams, SURVEY_DEAL_EVENT } from '../src/bitrix24/install'
import { MemoryInvitationStore, type InvitationStore } from '../src/api/invitation'
import type { TriggerStore, TriggerTenant } from '../src/bitrix24/trigger'
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

/**
 * Пер-портальный стор и приглашения (#49) резолвятся резолвером `tenant`, а не приходят значениями.
 * Тесты продолжают говорить про `store`/`invitations` — так читается то, что они проверяют, — а шим
 * собирает из них тенанта.
 */
type DepsOver = Omit<Partial<DealUpdateDeps>, 'tenant'> & {
  store?: TriggerStore
  invitations?: InvitationStore
  tenant?: DealUpdateDeps['tenant']
}

function deps(over: DepsOver = {}): DealUpdateDeps {
  const { store: overStore, invitations: overInvitations, tenant: overTenant, ...rest } = over
  const tenant: TriggerTenant = {
    store: overStore ?? store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }),
    invitations: overInvitations ?? new MemoryInvitationStore()
  }
  return {
    storedApplicationToken: async () => 'app-token-fake-0000000000000000', // по умолчанию сходится
    fetchDeal: async () => ({ deal: { ...dealFields }, productRows: [] }),
    tenant: overTenant ?? (async () => tenant),
    ...rest
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
    expect(res).toEqual({ kind: 'forged', reason: 'unknown_portal', memberId: 'member-id-fake-0000000000000000' })
    expect(fetchDeal).not.toHaveBeenCalled() // анти-амплификация: подделка не порождает исходящий REST
  })

  it('application_token не сошёлся → forged/token_mismatch, без догрузки', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runDealUpdate(rawEvent(), deps({ storedApplicationToken: async () => 'ДРУГОЙ-токен', fetchDeal }))
    expect(res).toEqual({ kind: 'forged', reason: 'token_mismatch', memberId: 'member-id-fake-0000000000000000' })
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('боевой wire-формат (form-urlencoded bracket) декодится parseBracketForm и триггерит', async () => {
    // Как шлёт Bitrix online-событие: ПЛОСКИЙ объект с литеральными скобками (h3 readBody). Эндпоинт
    // прогоняет его через parseBracketForm ПЕРЕД runDealUpdate — воспроизводим тот же шов.
    const flat = {
      event: 'ONCRMDEALUPDATE',
      'data[FIELDS][ID]': '759',
      'auth[member_id]': 'member-id-fake-0000000000000000',
      'auth[domain]': 'acme.bitrix24.ru',
      'auth[application_token]': 'app-token-fake-0000000000000000',
      ts: '1736405807'
    }
    const raw = parseBracketForm(flat)
    // Санити: 2-уровневая вложенность собралась (регресс на односкобочный парсер — data был бы undefined).
    expect(raw).toMatchObject({ data: { FIELDS: { ID: '759' } }, auth: { member_id: 'member-id-fake-0000000000000000' } })
    const res = await runDealUpdate(raw, deps())
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect(res.results).toHaveLength(1)
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
    const inv = await invitations.peek(res.results[0]!.token, new Date())
    expect(inv?.context.dealId).toBe(759)
    expect(inv?.context.companyId).toBe(101)
  })

  it('токен сошёлся, но стадия не триггерит ни одного опроса → ok с пустым списком', async () => {
    const res = await runDealUpdate(
      rawEvent(),
      deps({ fetchDeal: async () => ({ deal: { ...dealFields, STAGE_ID: 'C1:NEW' }, productRows: [] }) })
    )
    expect(res).toEqual({ kind: 'ok', results: [], deduped: [], failed: [] })
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
    const inv = await invitations.peek(res.results[0]!.token, new Date())
    expect(inv?.context.products).toEqual([{ productId: 42, productName: 'Внедрение' }])
  })
})

describe('runDealUpdate — подтверждение перехода стадии (confirmStageEntry, #17)', () => {
  it('переход подтверждён → приглашение выписывается; проверка получила сделку+стадию+портал', async () => {
    const confirmStageEntry = vi.fn(async () => ({ fresh: true }))
    const res = await runDealUpdate(rawEvent(), deps({ confirmStageEntry }))
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') expect(res.results).toHaveLength(1)
    expect(confirmStageEntry).toHaveBeenCalledWith(759, 'C1:WON', 'member-id-fake-0000000000000000')
  })

  it('перехода не было (обычный апдейт давно стоящей сделки) → skipped, приглашение НЕ создано', async () => {
    const invitations = new MemoryInvitationStore()
    const create = vi.spyOn(invitations, 'create')
    const res = await runDealUpdate(rawEvent(), deps({ confirmStageEntry: async () => ({ fresh: false }), invitations }))
    expect(res).toEqual({ kind: 'skipped', reason: 'stale_stage', dealId: 759, stageId: 'C1:WON' })
    expect(create).not.toHaveBeenCalled() // не только outcome — приглашения действительно нет
  })

  it('стадия не триггерит опросы → историю НЕ спрашиваем (дешёвый гейт по БД экономит REST)', async () => {
    const confirmStageEntry = vi.fn(async () => ({ fresh: true }))
    // сделка в C1:WON, но триггер настроен на другую стадию
    const res = await runDealUpdate(
      rawEvent(),
      deps({ store: store({ 'C1:LOSE': ['x'] }, { x: 1 }), confirmStageEntry })
    )
    expect(confirmStageEntry).not.toHaveBeenCalled()
    expect(res).toEqual({ kind: 'ok', results: [], deduped: [], failed: [] })
  })

  it('проверка НЕ задана (путь робота) → работает как раньше, без обращения к истории', async () => {
    const res = await runDealUpdate(rawEvent(), deps())
    expect(res.kind).toBe('ok')
  })

  it('нет стадии в сделке → проверку не зовём (триггерить всё равно нечего)', async () => {
    const confirmStageEntry = vi.fn(async () => ({ fresh: true }))
    const res = await runDealUpdate(
      rawEvent(),
      deps({ fetchDeal: async () => ({ deal: { ID: '759' }, productRows: [] }), confirmStageEntry })
    )
    expect(confirmStageEntry).not.toHaveBeenCalled()
    expect(res).toEqual({ kind: 'ok', results: [], deduped: [], failed: [] })
  })

  it('подделка токена → до проверки перехода дело не доходит (порядок гейтов)', async () => {
    const confirmStageEntry = vi.fn(async () => ({ fresh: true }))
    const res = await runDealUpdate(
      rawEvent(),
      deps({ storedApplicationToken: async () => 'ДРУГОЙ-токен', confirmStageEntry })
    )
    expect(res.kind).toBe('forged')
    expect(confirmStageEntry).not.toHaveBeenCalled()
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

describe('гроздь событий одного перехода → одно приглашение (#138)', () => {
  /**
   * ⚠️ Проверяется ПРОВОДКА, а не правило: правило само по себе покрыто в `invite-delivery.test.ts`.
   * Здесь важно другое — что событийный путь действительно доводит до него ключ перехода и не
   * выписывает приглашение сам. Без этого теста правило можно было бы вовсе не подключить, и весь
   * набор остался бы зелёным.
   */
  const TRANSITION = { id: '4242', at: new Date('2026-08-20T10:00:00Z') }

  function withDelivery(issued: string[], seen: { id?: string; at?: Date; memberId?: string }): DealUpdateDeps {
    return deps({
      confirmStageEntry: async () => ({ fresh: true, transitionId: TRANSITION.id, transitionAt: TRANSITION.at }),
      issue: (ctx: { transition: { id?: string; at?: Date }; memberId: string }) => {
        seen.id = ctx.transition.id
        seen.at = ctx.transition.at
        seen.memberId = ctx.memberId
        // Имитация доставки: первое событие выписывает, следующие видят уже созданное дело.
        return () => {
          if (issued.length > 0) return Promise.resolve(undefined)
          issued.push('выписано')
          return Promise.resolve({ surveyKey: 'csat_postdeal', versionNo: 2, token: 'tok-1' })
        }
      }
    })
  }

  it('ключ перехода, момент перехода и АВТОРИТЕТНЫЙ member_id доезжают до доставки', async () => {
    // member_id берётся из ПРОВЕРЕННОЙ части события, а не из тела POST: иначе чужой портал получил
    // бы приглашение в своих данных. Поэтому в недоверенную часть кладём ДРУГОЙ member_id — без него
    // тест не мог бы упасть по заявленной причине, он лишь проверял бы, что значение доехало.
    const seen: { id?: string; at?: Date; memberId?: string } = {}
    await runDealUpdate(
      rawEvent({ member_id: 'member-id-ATTACKER-000000000000', data: { FIELDS: { ID: '759', member_id: 'member-id-ATTACKER-000000000000' } } }),
      withDelivery([], seen)
    )
    expect(seen.id).toBe('4242')
    expect(seen.at?.toISOString()).toBe('2026-08-20T10:00:00.000Z')
    expect(seen.memberId).toBe('member-id-fake-0000000000000000')
  })

  it('второе событие того же перехода → приглашение НЕ выписано, но исход штатный', async () => {
    const issued: string[] = []
    const seen: { id?: string } = {}
    const d = withDelivery(issued, seen)
    const first = await runDealUpdate(rawEvent(), d)
    const second = await runDealUpdate(rawEvent(), d)
    expect(first).toMatchObject({ kind: 'ok', deduped: [] })
    expect(first.kind === 'ok' && first.results).toHaveLength(1)
    expect(second).toMatchObject({ kind: 'ok', deduped: ['csat_postdeal'] })
    expect(second.kind === 'ok' && second.results).toHaveLength(0)
    expect(issued, 'по одному переходу выписано больше одного приглашения').toHaveLength(1)
  })

  it('без доставки путь работает по-старому — приглашение выписывается сразу', async () => {
    // Обратная совместимость: ядровые тесты и путь робота `issue` не передают.
    const out = await runDealUpdate(rawEvent(), deps({
      confirmStageEntry: async () => ({ fresh: true, transitionId: '4242' })
    }))
    expect(out.kind === 'ok' && out.results).toHaveLength(1)
  })
})

describe('runDealUpdate — портал выбирается ПОСЛЕ сверки токена (#49)', () => {
  it('токен не сошёлся → тенант НЕ резолвится (стор чужого портала даже не трогаем)', async () => {
    // ⚠️ Смысл резолвера ровно в порядке. Пока стор приходил значением, он выбирался до того, как
    // мы знали, чей это POST: недоверенное тело фактически указывало, в чьи данные писать.
    const tenant = vi.fn(async () => ({ store: store({}, {}), invitations: new MemoryInvitationStore() }))
    const res = await runDealUpdate(rawEvent(), deps({ storedApplicationToken: async () => 'другой', tenant }))
    expect(res.kind).toBe('forged')
    expect(tenant).not.toHaveBeenCalled()
  })

  it('тенант резолвится по ПОДТВЕРЖДЁННОМУ member_id', async () => {
    const tenant = vi.fn(async () => ({
      store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }),
      invitations: new MemoryInvitationStore()
    }))
    const res = await runDealUpdate(rawEvent(), deps({ tenant }))
    expect(res.kind).toBe('ok')
    expect(tenant).toHaveBeenCalledWith('member-id-fake-0000000000000000')
  })

  it('портал исчез между сверкой и выбором стора → ignored/tenant, догрузки сделки нет', async () => {
    const fetchDeal = vi.fn(deps().fetchDeal)
    const res = await runDealUpdate(rawEvent(), deps({ tenant: async () => undefined, fetchDeal }))
    expect(res).toEqual({ kind: 'ignored', reason: 'tenant' })
    // Портала нет — писать некуда, значит и спрашивать сделку у него незачем.
    expect(fetchDeal).not.toHaveBeenCalled()
  })

  it('приглашение ложится в стор ИМЕННО того тенанта, что вернул резолвер', async () => {
    const mine = new MemoryInvitationStore()
    const foreign = new MemoryInvitationStore()
    const foreignCreate = vi.spyOn(foreign, 'create')
    const res = await runDealUpdate(rawEvent(), deps({
      tenant: async () => ({ store: store({ 'C1:WON': ['csat_postdeal'] }, { csat_postdeal: 2 }), invitations: mine }),
      invitations: foreign
    }))
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect(await mine.peek(res.results[0]!.token, new Date())).toBeDefined()
    expect(foreignCreate).not.toHaveBeenCalled()
  })
})
