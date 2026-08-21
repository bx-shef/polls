import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dashboardDecision, type DashboardDeps } from '../server/utils/dashboard-view'
import { createDashboardLimiter } from '../server/utils/dashboard-limit'
import type { PortalSession } from '../src/api/session'
import type { CompiledVersion, Question, ResponseRecord } from '../src/domain/schema'
import type { IStore } from '../src/store/types'

/**
 * Решение дашборда (#47/#49) — ИСПОЛНЯЕМО.
 *
 * ⚠️ Здесь проверяется ПОРЯДОК, а не наличие. Лимит до работы, портал только из подписанной сессии,
 * тенант до выбора стора, анонимность до цифр — все четыре формы «проверка стоит раньше» и «проверка
 * стоит позже» содержат одни и те же строки, поэтому греп-гард их не отличает, а порога покрытия у
 * `server/**` в проекте нет. Ровно на этом месте у соседнего роута (#18) мутация «взять портал из
 * тела запроса» прошла весь набор зелёной.
 */
const SESSION: PortalSession = { portalId: 'member-id-fake-0000000000000000', exp: 9_999_999_999 }

const q = (over: Partial<Question> & { key: string; text: string }): Question => ({
  type: 'single', metric: 'scale', required: true, options: [], ...over
})

const VERSION: CompiledVersion = {
  surveyKey: 'csat_postdeal',
  title: 'Оценка после сделки',
  lang: 'ru',
  versionNo: 2,
  questions: [
    q({ key: 'q_nps', text: 'Порекомендуете?', metric: 'nps' }),
    q({
      key: 'q_reason',
      text: 'Что было важнее всего?',
      metric: 'choice',
      options: [
        { key: 'speed', label: 'Скорость' },
        { key: 'price', label: 'Цена' },
        { key: 'refusal', label: 'Отказ от услуги' }
      ]
    })
  ],
  compiledAt: '2026-07-24T10:00:00.000Z'
}

/** Ответ с оценкой NPS и одним выбором. */
function record(i: number, choice: string, npsValue = 9): ResponseRecord {
  return {
    id: `r-${i}`,
    surveyKey: 'csat_postdeal',
    versionNo: 2,
    submittedAt: '2026-07-24T10:05:00.000Z',
    context: {},
    answers: [
      { questionKey: 'q_nps', metric: 'nps', valueChoice: [], valueNumber: npsValue, valueText: null },
      { questionKey: 'q_reason', metric: 'choice', valueChoice: [choice], valueNumber: null, valueText: null }
    ]
  }
}

/** 8 «Скорость», 7 «Цена», 1 «Отказ от услуги» — выборка достаточная, а последняя ячейка точечная. */
const RESPONSES: ResponseRecord[] = [
  ...Array.from({ length: 8 }, (_, i) => record(i, 'speed')),
  ...Array.from({ length: 7 }, (_, i) => record(100 + i, 'price')),
  record(200, 'refusal')
]

/**
 * ⚠️ `version` — параметр БЕЗ значения по умолчанию, и это не придирка: с `= VERSION` явный вызов
 * `fakeStore(rs, undefined)` молча получал бы дефолт, и тест «опроса нет → 404» проходил бы,
 * проверяя счастливый путь. Ровно на этом обжёгся тест соседнего роута (#18).
 */
function fakeStore(rs: ResponseRecord[] = RESPONSES, version: CompiledVersion | null = VERSION) {
  return {
    currentVersion: vi.fn(async () => version ?? undefined),
    listResponses: vi.fn(async () => rs)
  } as unknown as IStore
}

/**
 * ⚠️ Порядок пишется ОБЁРТКОЙ поверх подменённой реализации, а не вместо неё. Пока запись стояла в
 * дефолтах, любой `over` её снимал — и тест «лимит стоит первым» сравнивал пустой список с пустым,
 * то есть проходил бы и на роуте вообще без лимита.
 */
function deps(over: Partial<DashboardDeps> = {}, store: IStore = fakeStore()) {
  const seen: string[] = []
  const base: DashboardDeps = {
    allowIp: () => true,
    allowPortal: () => true,
    session: () => ({ ok: true, session: SESSION, devOpen: false }),
    tenant: async () => ({ ok: true, portalId: 7 }),
    storeFor: async () => store,
    ...over
  }
  const d: DashboardDeps = {
    allowIp: (ip) => { seen.push('allowIp'); return base.allowIp(ip) },
    allowPortal: (id) => { seen.push('allowPortal'); return base.allowPortal(id) },
    session: () => { seen.push('session'); return base.session() },
    tenant: (s) => { seen.push('tenant'); return base.tenant(s) },
    storeFor: (id) => { seen.push('storeFor'); return base.storeFor(id) }
  }
  return { ...d, seen }
}

const ask = (d: DashboardDeps, over: Partial<{ ip: string; surveyKey: string; version: unknown }> = {}) =>
  dashboardDecision({ ip: '203.0.113.9', surveyKey: 'csat_postdeal', version: undefined, ...over }, d)

describe('дашборд: решение роута', () => {
  it('счастливый путь: агрегаты по стору ПОДТВЕРЖДЁННОГО портала', async () => {
    const store = fakeStore()
    const d = deps({}, store)
    const out = await ask(d)
    expect(out.status).toBe(200)
    expect(out.body.suppressed).toBe(false)
    expect(out.body.n).toBe(16)
    expect(d.seen).toEqual(['allowIp', 'session', 'tenant', 'allowPortal', 'storeFor'])
    expect((store.listResponses as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('портал для стора берётся из ТЕНАНТА, а не из ключа опроса или адреса', async () => {
    // Мутация «`storeFor(undefined)`» открыла бы сотруднику одного заказчика срезы другого — с
    // именами клиентов и ответственных.
    const storeFor = vi.fn(async () => fakeStore())
    await ask(deps({ storeFor, tenant: async () => ({ ok: true, portalId: 42 }) }))
    expect(storeFor).toHaveBeenCalledWith(42)
  })

  it('ЛИМИТ адреса стоит ПЕРВЫМ — до разбора сессии и до похода в базу', async () => {
    // ⚠️ Порядок и есть защита: `tenant` ходит в базу, а адрес дашборда открыт из интернета.
    const d = deps({ allowIp: () => false })
    const out = await ask(d)
    expect(out.status).toBe(429)
    expect(d.seen, 'после отказа лимита сделана лишняя работа').toEqual(['allowIp'])
  })

  it('ЛИМИТ портала стоит ПОСЛЕ тенанта и ДО чтения ответов', async () => {
    // Ключ этого потолка — числовой `portal.id` из подписанной сессии: подделать нельзя, а за
    // корпоративным прокси все сотрудники приходят с одного адреса.
    const store = fakeStore()
    const d = deps({ allowPortal: () => false }, store)
    const out = await ask(d)
    expect(out.status).toBe(429)
    expect(d.seen).toEqual(['allowIp', 'session', 'tenant', 'allowPortal'])
    expect((store.listResponses as unknown as { mock: { calls: unknown[] } }).mock.calls,
      'ответы прочитаны вопреки исчерпанному потолку').toHaveLength(0)
  })

  it('лимит портала получает ИМЕННО portalId тенанта', async () => {
    const allowPortal = vi.fn(() => true)
    await ask(deps({ allowPortal, tenant: async () => ({ ok: true, portalId: 42 }) }))
    expect(allowPortal).toHaveBeenCalledWith(42)
  })

  it('нет сессии портала → 401 ТЕЛОМ, без обращения к стору', async () => {
    const store = fakeStore()
    const d = deps({ session: () => ({ ok: false, status: 401 }) }, store)
    const out = await ask(d)
    expect(out.status).toBe(401)
    expect(out.body.ok).toBe(false)
    expect(typeof out.body.error).toBe('string')
    expect(d.seen).toEqual(['allowIp', 'session'])
  })

  it('секрет не задан → 503, и текст НЕ называет переменную окружения', async () => {
    // Гейт срабатывает раньше проверки ключа, поэтому `/d/что-угодно` открыт любому из интернета:
    // точный доклад рассказал бы неизвестному, что авторизация дашборда сейчас не работает.
    const out = await ask(deps({ session: () => ({ ok: false, status: 503 }) }))
    expect(out.status).toBe(503)
    expect(String(out.body.error)).not.toMatch(/DASHBOARD_AUTH_SECRET/)
  })

  it('сессия жива, а портала в базе нет → 401, а не общий стор', async () => {
    const storeFor = vi.fn(async () => fakeStore())
    const out = await ask(deps({ tenant: async () => ({ ok: false, status: 401 }), storeFor }))
    expect(out.status).toBe(401)
    expect(storeFor, 'показан стор по умолчанию удалённому заказчику').not.toHaveBeenCalled()
  })

  it('пустой и слишком длинный ключ опроса → 400', async () => {
    for (const surveyKey of ['', 'x'.repeat(201)]) {
      expect((await ask(deps(), { surveyKey })).status).toBe(400)
    }
  })

  it('опроса нет → 404', async () => {
    const out = await ask(deps({}, fakeStore(RESPONSES, null)))
    expect(out.status).toBe(404)
  })

  it('выборка меньше порога → весь дашборд скрыт, цифр в ответе нет', async () => {
    const out = await ask(deps({}, fakeStore([record(1, 'speed'), record(2, 'price')])))
    expect(out.status).toBe(200)
    expect(out.body.suppressed).toBe(true)
    expect(out.body.nps, 'метрика уехала при подавленной выборке').toBeUndefined()
    expect(out.body.clients).toBeUndefined()
  })

  it('ключ опроса в ответе НЕ зеркалим', async () => {
    const out = await ask(deps(), { surveyKey: 'csat_postdeal' })
    expect(JSON.stringify(out.body)).not.toContain('csat_postdeal')
  })

  it('?version=N фильтрует; чужое и негодное значение игнорируется', async () => {
    const mixed = [...RESPONSES, { ...record(300, 'speed'), versionNo: 3 }]
    const d = () => deps({}, fakeStore(mixed))
    expect((await ask(d(), { version: '3' })).body.n).toBe(1)
    expect((await ask(d(), { version: '99' })).body.n, 'принята несуществующая версия').toBe(17)
    expect((await ask(d(), { version: ['2', '3'] })).body.n, 'массив скоэрсен в число').toBe(17)
    expect((await ask(d(), { version: '2.5' })).body.n).toBe(17)
  })

  it('список версий считается ДО фильтра — иначе селектор схлопывается', async () => {
    const mixed = [...RESPONSES, { ...record(300, 'speed'), versionNo: 3 }]
    const out = await ask(deps({}, fakeStore(mixed)), { version: '3' })
    expect(out.body.versions).toEqual([2, 3])
  })
})

describe('дашборд: k-анонимность распределения по ячейкам', () => {
  it('точечная ячейка не показывается, и вместе с ней уходит вторая (#49)', async () => {
    // 8 «Скорость», 7 «Цена», 1 «Отказ от услуги». Показать первые две значило бы назвать третью:
    // сумма ячеек равна общему N, а его мы публикуем.
    const out = await ask(deps())
    const dist = out.body.distribution as { items: Array<{ label: string }>; hiddenBins: number }
    const labels = dist.items.map((i) => i.label)
    expect(labels, 'единственный «Отказ от услуги» назван поимённо').not.toContain('Отказ от услуги')
    expect(labels, 'комплементарного подавления нет — скрытая ячейка считается вычитанием')
      .not.toContain('Цена')
    expect(labels).toEqual(['Скорость'])
    expect(dist.hiddenBins, 'график читается как полный').toBe(2)
  })

  it('все ячейки крупные → ничего не скрывается', async () => {
    const rs = [
      ...Array.from({ length: 8 }, (_, i) => record(i, 'speed')),
      ...Array.from({ length: 7 }, (_, i) => record(100 + i, 'price'))
    ]
    const out = await ask(deps({}, fakeStore(rs)))
    const dist = out.body.distribution as { items: Array<{ label: string }>; hiddenBins: number }
    expect(dist.items.map((i) => i.label)).toEqual(['Скорость', 'Цена'])
    expect(dist.hiddenBins).toBe(0)
  })

  it('скрытые метки и их счётчики наружу НЕ идут', async () => {
    const out = await ask(deps())
    expect(JSON.stringify(out.body.distribution), 'подавление декоративное')
      .not.toContain('Отказ от услуги')
  })
})

describe('дашборд: потолки запросов', () => {
  const t = (ms: number) => new Date(1_700_000_000_000 + ms)

  it('пер-IP потолок отсекает флуд с одного адреса и отпускает через окно', async () => {
    const lim = createDashboardLimiter({ ipLimit: 2, windowMs: 1000 })
    expect(lim.allowIp('a', t(0))).toBe(true)
    expect(lim.allowIp('a', t(1))).toBe(true)
    expect(lim.allowIp('a', t(2))).toBe(false)
    expect(lim.allowIp('b', t(3)), 'потолок одного адреса задел другой').toBe(true)
    expect(lim.allowIp('a', t(1500))).toBe(true)
  })

  it('шумный портал не тратит потолок соседа', async () => {
    // ⚠️ Ради этого ключ и не адрес: за корпоративным прокси все сотрудники портала приходят одним
    // IP, и низкий потолок на адрес выглядел бы случайным миганием дашборда.
    const lim = createDashboardLimiter({ portalLimit: 2, windowMs: 1000 })
    expect(lim.allowPortal(1, t(0))).toBe(true)
    expect(lim.allowPortal(1, t(1))).toBe(true)
    expect(lim.allowPortal(1, t(2))).toBe(false)
    expect(lim.allowPortal(2, t(3))).toBe(true)
  })

  it('глобальный потолок держит инстанс, когда порталов много', async () => {
    // Сумма пер-портальных потолков растёт с числом установленных порталов, а пул соединений — нет.
    const lim = createDashboardLimiter({ portalLimit: 100, globalLimit: 2, windowMs: 1000 })
    expect(lim.allowPortal(1, t(0))).toBe(true)
    expect(lim.allowPortal(2, t(1))).toBe(true)
    expect(lim.allowPortal(3, t(2)), 'третий портал прошёл мимо глобального потолка').toBe(false)
  })

  it('режим памяти (portalId undefined) тоже под потолком', async () => {
    const lim = createDashboardLimiter({ portalLimit: 1, windowMs: 1000 })
    expect(lim.allowPortal(undefined, t(0))).toBe(true)
    expect(lim.allowPortal(undefined, t(1))).toBe(false)
  })

  it('отказ пер-портального потолка НЕ тратит глобальный', async () => {
    // Иначе арендатор платил бы глобальным потолком за отказы соседа.
    const lim = createDashboardLimiter({ portalLimit: 1, globalLimit: 2, windowMs: 1000 })
    expect(lim.allowPortal(1, t(0))).toBe(true) // портал 1: 1/1, глобально 1/2
    expect(lim.allowPortal(1, t(1))).toBe(false) // отказ пер-портального — глобальный не тронут
    expect(lim.allowPortal(2, t(2))).toBe(true) // глобально 2/2
    expect(lim.allowPortal(3, t(3))).toBe(false)
  })
})

describe('дашборд: боевая проводка роута', () => {
  // ⚠️ Единственная точка, где решение соединяется с настоящими потолками. Тесты выше внедряют
  // `allowIp`/`allowPortal` сами — то есть проверяют форму, а не то, что роут её действительно
  // заполняет. Мутация «`allowIp: () => true`» снимает защиту целиком и без этого гарда не роняет
  // ничего: ровно так же в #18 из боевой проводки пропадал `responseId`.
  const src = readFileSync(resolve(process.cwd(), 'server/api/dashboard/[key].get.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('оба потолка подключены к БОЕВОМУ лимитеру, а не к заглушке', () => {
    expect(src, 'потолок адреса отвязан от лимитера').toMatch(/allowIp:\s*\(\s*ip\s*\)\s*=>\s*dashboardLimiter\.allowIp\(\s*ip\s*\)/)
    expect(src, 'потолок портала отвязан от лимитера').toMatch(/allowPortal:\s*\(\s*portalId\s*\)\s*=>\s*dashboardLimiter\.allowPortal\(\s*portalId\s*\)/)
  })

  it('роут НИЧЕГО не решает сам — иначе исполняемые тесты выше проверяют не тот код', () => {
    expect(src, 'решение вернулось в роут мимо `dashboardDecision`').toContain('dashboardDecision(')
    expect(src, 'в роуте появилась своя ветка подавления').not.toContain('meetsAnonymity')
    expect(src, 'в роуте появился свой счёт').not.toMatch(/\b(npsFor|csatFor|breakdownBy|suppressSmallBins)\(/)
  })

  it('адрес берётся из `requestIp`, а не из заголовка тела запроса', () => {
    // Ключ пер-IP потолка обязан быть тем же, что у остальных публичных путей: свой разбор
    // `X-Forwarded-For` в роуте — это доверие к заголовку, который клиент пишет сам.
    expect(src).toMatch(/ip:\s*requestIp\(event\)/)
  })
})
