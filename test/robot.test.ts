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

/**
 * Валидный недоверенный POST робота (значения заведомо фейковые).
 *
 * ⚠️ `ts` в дефолте НЕТ намеренно. Стояло фиксированное `'1736405807'` (январь 2025) — то есть любой
 * тест на этой фикстуре молча уходил в фолбэк «свои часы», и следующий, кто положится на «фикстурный
 * `ts` доезжает до ключа», получил бы другое. Кому нужен момент — передаёт его явно.
 *
 * ⚠️ `member_id` верхнего уровня — ЧУЖОЙ и посторонний: авторитетный источник ровно один,
 * `auth.member_id`. Без этого «злого» значения assert про `ctx.memberId` истинен при любой
 * реализации, читающей хоть проверенную, хоть непроверенную часть тела.
 */
const rawRobot = (over: Record<string, unknown> = {}) => ({
  code: 'survey_launch',
  document_id: ['crm', 'CCrmDocumentDeal', 'DEAL_759'],
  member_id: 'member-id-ATTACKER-0000000000',
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
    // ⚠️ Три числа, а не одно: `results: []` теперь означает ЧЕТЫРЕ разных исхода, и «нечего было
    // делать» обязано отличаться от «дедуп отсёк» и «не смогли» — иначе живой прогон (#122) читает
    // ноль и не знает, что произошло.
    expect(res).toMatchObject({ kind: 'ok', results: [], deduped: [], failed: [], dealId: 759 })
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

  it('окно правдоподобия — ЧАС, и это значение запиннено литералом', () => {
    // ⚠️ Пин обязателен. Границы ниже считаются ОТ константы, то есть проверяют соотношение, а не
    // величину: мутация «24 часа → 10 лет» их не роняла, хотя ровно она и возвращает дефект
    // «прошлогодний ответ гасит сегодняшний повод спросить». Час — потому что робота зовут В МОМЕНТ
    // входа в стадию, и легитимное расхождение измеряется секундами.
    expect(ROBOT_TS_SKEW_MS).toBe(60 * 60_000)
  })

  it('часы портала правдоподобны → ключ и момент берутся из них', () => {
    const portalSec = nowSec - 5
    const t = robotTransition(String(portalSec), now)
    expect(t.id).toBe(`robot-${portalSec}`)
    expect(t.at.toISOString()).toBe(new Date(portalSec * 1000).toISOString())
    expect(t.source).toBe('portal')
    expect(t.reason).toBeUndefined()
  })

  it('число вместо строки принимается так же (wire-формат бывает разным)', () => {
    expect(robotTransition(nowSec, now).id).toBe(`robot-${nowSec}`)
  })

  it('ПОВТОР ДОСТАВКИ того же тела даёт ТОТ ЖЕ ключ', () => {
    // ⚠️ Формулировка сужена намеренно. Здесь доказано ровно одно: одинаковый `ts` → одинаковый ключ,
    // то есть повтор ДОСТАВКИ (та же секунда в теле) упрётся в поиск по маркеру. Повторное
    // ИСПОЛНЕНИЕ активити движком bizproc принесёт новый момент — новый ключ, второе дело, вторая
    // ссылка. Прежнее имя теста обещало «повтор bizproc не плодит дело» и читалось как доказательство
    // того, чего тут нет: форма POST робота вживую не сверена (#122).
    const portalSec = String(nowSec - 3)
    const a = robotTransition(portalSec, now)
    const b = robotTransition(portalSec, new Date(now.getTime() + 900))
    expect(a.id).toBe(b.id)
    expect(a.at.getTime()).toBe(b.at.getTime())
  })

  it('другой переход (другая секунда) → ДРУГОЙ ключ: возврат в стадию — законный повод спросить', () => {
    expect(robotTransition(String(nowSec), now).id).not.toBe(robotTransition(String(nowSec - 1), now).id)
  })

  for (const [name, ts, reason] of [
    ['мусор', 'позавчера', 'not_number'], ['пусто', '', 'missing'], ['нет поля', undefined, 'missing'],
    ['ноль', '0', 'not_number'], ['отрицательное', '-5', 'not_number'], ['дробное', '1.5', 'not_number'],
    ['миллисекунды вместо секунд', String(nowSec * 1000), 'future'],
    ['объект', { a: 1 }, 'not_number'], ['массив', ['1'], 'not_number'], ['булево', true, 'not_number'],
    ['строка длиннее капа', '2026-08-21T10:00:00+03:00', 'not_number']
  ] as const) {
    it(`негодный ts (${name}) → берём СВОИ часы, а не то, что прислали`, () => {
      const t = robotTransition(ts, now)
      expect(t.id).toBe(`robot-${nowSec}`)
      expect(t.at.getTime()).toBe(now.getTime())
      // ⚠️ Причина фолбэка обязана быть НАЗВАНА: на своих часах ключ меняется каждую секунду, то есть
      // дедупа у робота нет вовсе. Без этой пометки в логе такое состояние невидимо — функция чистая
      // и молчит, а сводка печатает только число приглашений.
      expect(t.source).toBe('clock')
      expect(t.reason).toBe(reason)
    })
  }

  it('граница окна: ровно −1 час берётся у портала, на миллисекунду дальше — свои часы', () => {
    // ⚠️ Границы литералами (`60 * 60_000`), а не через константу: считая от неё, тест истинен при
    // любом её значении — ровно та тавтология, из-за которой мутация «окно в 10 лет» проходила.
    const edge = Math.floor((now.getTime() - 60 * 60_000) / 1000)
    expect(robotTransition(String(edge), now).id).toBe(`robot-${edge}`)
    const beyond = Math.floor((now.getTime() - 60 * 60_000 - 2000) / 1000)
    const t = robotTransition(String(beyond), now)
    expect(t.id).toBe(`robot-${nowSec}`)
    expect(t.reason).toBe('skew')
  })

  it('момент из БУДУЩЕГО клампится всегда, даже внутри окна', () => {
    // ⚠️ Перехода в будущем не бывает — робота зовут в момент входа в стадию. Оставь мы момент
    // впереди, `hasResponseSince(…, at)` не вернул бы `true` НИКОГДА: ветка «клиент уже ответил»
    // мертва, и повторный вызов заново приглашает ответившего клиента новым живым токеном.
    const soon = nowSec + 30
    const t = robotTransition(String(soon), now)
    expect(t.id).toBe(`robot-${nowSec}`)
    expect(t.reason).toBe('future')
  })

  it('константный ts в пределах суток НЕ проходит как правдоподобный', () => {
    // Живой класс дефекта: портал шлёт не время, а ДАТУ (усечение до полуночи). Суточное окно такое
    // значение пропускало, маркер `robot-<полночь>` становился один на весь день, и после первого же
    // ответа клиента опрос по сделке молча выключался до полуночи.
    const midnight = Math.floor(new Date('2026-08-21T00:00:00.000Z').getTime() / 1000)
    expect(robotTransition(String(midnight), now).reason).toBe('skew')
  })

  it('ключ не содержит двоеточий — иначе маркер перестанет разбираться', () => {
    // `markerMatchesSurvey` режет `stage:<переход>:<опрос>` по ВТОРОМУ двоеточию: лишнее в ключе
    // перехода означало бы, что мы перестали узнавать свои же дела, и закрытие ответом молча умерло.
    expect(robotTransition(String(nowSec), now).id).not.toContain(':')
  })
})

describe('runRobotTrigger — доставка приглашения (#175)', () => {
  const now = new Date('2026-08-21T10:00:00.000Z')
  const nowSec = Math.floor(now.getTime() / 1000)
  type IssueCtx = { transition: { id?: string; at?: Date }; memberId: string }

  it('выписка идёт через `issue` (дело в таймлайне), а не в фолбэк «только токен»', async () => {
    // Ровно тот дефект, ради которого задача: без `issue` приглашение появлялось в базе, дела не
    // было, и сотрудник ссылку не видел.
    const issue = vi.fn((_ctx: IssueCtx) => async () => ({ surveyKey: 'csat_postdeal', versionNo: 2, token: 'tk' }))
    const ts = String(nowSec - 2)
    const res = await runRobotTrigger(rawRobot({ ts }), deps({ issue, now }))
    expect(res.kind).toBe('ok')
    expect(issue).toHaveBeenCalledTimes(1)
    const ctx = issue.mock.calls[0]![0]
    expect(ctx.transition.id).toBe(`robot-${ts}`)
    // ⚠️ `at` проверяется НЕ для полноты. `makeInviteIssue` при `transition.at === undefined` пишет
    // `b24_invite_undelivered` и молчит: дела нет, исход снаружи — «ok, приглашений 0». Мутация
    // «не прокидывать `at`» типобезопасна (поле опционально) и проходила прежний набор целиком.
    expect(ctx.transition.at?.getTime()).toBe(Number(ts) * 1000)
    // ⚠️ Авторитетный источник ровно один: в теле лежит ещё и посторонний `member_id` верхнего уровня.
    expect(ctx.memberId).toBe('member-id-fake-0000000000000000')
  })

  it('ПОВТОРНЫЙ вызов с тем же ts: дедуп отсекает, второе приглашение не выписывается', async () => {
    // Исходный тест, а не равенство ключей: `issue` держит состояние по ключу перехода, как это
    // делает настоящая выписка через маркер дела.
    const seen = new Set<string>()
    const issue = (ctx: IssueCtx) => async (args: { surveyKey: string; versionNo: number }) => {
      const key = `${ctx.transition.id}:${args.surveyKey}`
      if (seen.has(key)) return undefined // «уже приглашали» — штатный исход, не ошибка
      seen.add(key)
      return { surveyKey: args.surveyKey, versionNo: args.versionNo, token: `tk-${seen.size}` }
    }
    const ts = String(nowSec - 2)
    const first = await runRobotTrigger(rawRobot({ ts }), deps({ issue, now }))
    const second = await runRobotTrigger(rawRobot({ ts }), deps({ issue, now }))
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('unreachable')
    expect(first.results).toHaveLength(1)
    expect(second.results).toEqual([])
    expect(second.deduped).toEqual(['csat_postdeal'])
  })

  it('негодный ts НЕ выключает робота: доставка идёт, ключ — со своих часов', async () => {
    // ⚠️ Регрессия, которую этот PR однажды и завёз: пока `ts` разбирался схемой строго, значение не
    // той формы валило `safeParse` ВСЕГО события — робот молча замолкал на всех порталах с одной
    // строкой `b24_robot_ignored reason=parse`. Форма `ts` вживую не сверена, так что это не теория.
    const issue = vi.fn((_ctx: IssueCtx) => async () => ({ surveyKey: 'csat_postdeal', versionNo: 2, token: 'tk' }))
    for (const ts of [{}, ['x'], true, '2026-08-21T10:00:00+03:00', 'позавчера']) {
      const res = await runRobotTrigger(rawRobot({ ts }), deps({ issue, now }))
      expect(res.kind, JSON.stringify(ts)).toBe('ok')
      if (res.kind !== 'ok') throw new Error('unreachable')
      expect(res.transition.id).toBe(`robot-${nowSec}`)
      expect(res.transition.source).toBe('clock')
    }
    expect(issue).toHaveBeenCalledTimes(5)
  })

  it('отказ выписки по ОДНОМУ опросу не роняет вызов и доезжает в лог И в исход', async () => {
    const onIssueError = vi.fn()
    const res = await runRobotTrigger(rawRobot(), deps({
      issue: () => async () => { throw new Error('портал недоступен') },
      onIssueError
    }))
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect(res.results).toEqual([])
    // ⚠️ `failed` — не косметика: без него `invitations: 0` в логе одинаково означает «стадия не
    // триггерит опросов» и «выписка отказала по всем», а различить надо именно это.
    expect(res.failed).toEqual(['csat_postdeal'])
    expect(res.deduped).toEqual([])
    expect(onIssueError).toHaveBeenCalledWith('csat_postdeal', expect.any(Error))
  })
})
