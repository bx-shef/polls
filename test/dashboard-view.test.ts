import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dashboardDecision, type DashboardDeps } from '../server/utils/dashboard-view'
import { createDashboardLimiter, DASHBOARD_RATE_MESSAGE } from '../server/utils/dashboard-limit'
import { PORTAL_GONE_MESSAGE } from '../src/api/session'
import type { PortalSession } from '../src/api/session'
import type { CompiledVersion, Question, ResponseRecord } from '../src/domain/schema'
import type { DashboardQuery, IStore } from '../src/store/types'
import { dashboardFromResponses } from '../src/domain/dashboard'

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
    q({ key: 'q_csat', text: 'Насколько довольны?', metric: 'csat' }),
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
function record(i: number, choice: string, npsValue = 9, over: Partial<ResponseRecord> = {}): ResponseRecord {
  return {
    id: `r-${i}`,
    surveyKey: 'csat_postdeal',
    versionNo: 2,
    submittedAt: '2026-07-24T10:05:00.000Z',
    context: { responsibleId: 5, responsibleName: 'Иванов' },
    answers: [
      { questionKey: 'q_nps', metric: 'nps', valueChoice: [], valueNumber: npsValue, valueText: null },
      { questionKey: 'q_csat', metric: 'csat', valueChoice: [], valueNumber: 4, valueText: null },
      { questionKey: 'q_reason', metric: 'choice', valueChoice: [choice], valueNumber: null, valueText: null }
    ],
    ...over
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
  // (см. комментарий выше: `null` — «версии нет», `undefined` сюда не передаём вовсе)
  //
  // ⚠️ Двойник считает агрегаты НАСТОЯЩЕЙ `dashboardFromResponses` — той же, что стоит в `MemoryStore`
  // и задаёт контракт для SQL. Двойник с выдуманными цифрами проверял бы, что вид их переложил, а не
  // что дашборд показывает правду; а двойник, отдающий пусто, скрыл бы половину веток вида.
  return {
    currentVersion: vi.fn(async () => version ?? undefined),
    dashboardAggregates: vi.fn(async (q: DashboardQuery) => dashboardFromResponses(rs, q))
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
    allowPortal: () => true,
    session: () => ({ ok: true, session: SESSION, devOpen: false }),
    tenant: async () => ({ ok: true, portalId: 7 }),
    storeFor: async () => store,
    ...over
  }
  const d: DashboardDeps = {
    allowPortal: (id) => { seen.push('allowPortal'); return base.allowPortal(id) },
    session: () => { seen.push('session'); return base.session() },
    tenant: (s) => { seen.push('tenant'); return base.tenant(s) },
    storeFor: (id) => { seen.push('storeFor'); return base.storeFor(id) }
  }
  return { ...d, seen }
}

const ask = (d: DashboardDeps, over: Partial<{ surveyKey: string; version: unknown }> = {}) =>
  dashboardDecision({ surveyKey: 'csat_postdeal', version: undefined, ...over }, d)

describe('дашборд: решение роута', () => {
  it('счастливый путь: агрегаты по стору ПОДТВЕРЖДЁННОГО портала', async () => {
    const store = fakeStore()
    const d = deps({}, store)
    const out = await ask(d)
    expect(out.status).toBe(200)
    expect(out.body.suppressed).toBe(false)
    expect(out.body.n).toBe(16)
    expect(d.seen).toEqual(['session', 'tenant', 'allowPortal', 'storeFor'])
    expect((store.dashboardAggregates as unknown as { mock: { calls: unknown[] } }).mock.calls,
      'хранилище опрошено дважды на обычном пути').toHaveLength(1)
  })

  it('портал для стора берётся из ТЕНАНТА, а не из ключа опроса или адреса', async () => {
    // Мутация «`storeFor(undefined)`» открыла бы сотруднику одного заказчика срезы другого — с
    // именами клиентов и ответственных.
    const storeFor = vi.fn(async () => fakeStore())
    await ask(deps({ storeFor, tenant: async () => ({ ok: true, portalId: 42 }) }))
    expect(storeFor).toHaveBeenCalledWith(42)
  })

  it('ЛИМИТ портала стоит ПОСЛЕ тенанта и ДО чтения ответов', async () => {
    // Ключ этого потолка — числовой `portal.id` из подписанной сессии: подделать нельзя, а за
    // корпоративным прокси все сотрудники приходят с одного адреса.
    const store = fakeStore()
    const d = deps({ allowPortal: () => false }, store)
    const out = await ask(d)
    expect(out.status).toBe(429)
    expect(d.seen).toEqual(['session', 'tenant', 'allowPortal'])
    expect((store.dashboardAggregates as unknown as { mock: { calls: unknown[] } }).mock.calls,
      'агрегаты посчитаны вопреки исчерпанному потолку').toHaveLength(0)
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
    expect(d.seen).toEqual(['session'])
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

  it('выборка меньше порога → в теле СОСТАВ ключей, а не выборочная пара', async () => {
    // ⚠️ Проверяем весь набор ключей, а не «`nps` не пришёл». Мутация «добавить в подавленную ветку
    // `responsibles`, посчитанные с `minN: 1`» уносит наружу ФИО сотрудников и проходит выборочную
    // проверку насквозь — а заявление «анонимность до цифр» держится именно составом ответа.
    const out = await ask(deps({}, fakeStore([record(1, 'speed'), record(2, 'price')])))
    expect(out.status).toBe(200)
    expect(out.body.suppressed).toBe(true)
    expect(Object.keys(out.body).sort())
      .toEqual(['n', 'ok', 'suppressed', 'threshold', 'title', 'version', 'versions'])
  })

  it('счастливый путь: агрегаты СЧИТАЮТСЯ, а не приходят пустыми', async () => {
    // ⚠️ Без проверки значений мутации «`nps: null`», «`csat` считается по вопросу NPS», «`trend: []`»,
    // «`responsibles: []`» обнуляют дашборд целиком при зелёном наборе.
    const out = await ask(deps())
    expect((out.body.nps as { n: number; nps: number }).n, 'NPS посчитан не по всем ответам').toBe(16)
    expect((out.body.nps as { nps: number }).nps, 'все оценки 9 — это промоутеры').toBe(100)
    expect((out.body.csat as { mean: number }).mean, 'CSAT считается по своему вопросу').toBe(4)
    expect((out.body.trend as unknown[]).length, 'тренда нет').toBeGreaterThan(0)
    expect((out.body.responsibles as Array<{ name: string }>).map((r) => r.name)).toEqual(['Иванов'])
  })

  it('точка тренда с малой выборкой подавлена — второй уровень анонимности', async () => {
    // Мутация «`npsTrend(responses, npsKey, 'month')` без `minN`» снимает подавление по месяцу: месяц
    // с одним ответом выходит отдельной точкой, а рядом лежит срез по ответственному.
    const rs = [
      ...Array.from({ length: 8 }, (_, i) => record(i, 'speed')),
      ...Array.from({ length: 7 }, (_, i) => record(100 + i, 'price')),
      record(300, 'speed', 9, { submittedAt: '2026-01-15T10:00:00.000Z' })
    ]
    const out = await ask(deps({}, fakeStore(rs)))
    const buckets = (out.body.trend as Array<{ bucket: string }>).map((p) => p.bucket)
    expect(buckets, 'месяц с одним ответом попал в тренд').toEqual(['2026-07'])
  })

  it('негодный ключ опроса отсекается ДО обращения к стору', async () => {
    // «Не тратим работу на отказ»: мутация «проверить ключ после `listResponses`» доводит
    // 200-символьную строку из адреса до стора.
    const store = fakeStore()
    const d = deps({}, store)
    await ask(d, { surveyKey: 'x'.repeat(201) })
    expect(d.seen, 'стор тронут ради заведомо негодного ключа').not.toContain('storeFor')
    expect((store.currentVersion as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('тексты отказов — ровно те, что объявлены, и 429 не называет потолок', async () => {
    // ⚠️ Мутация «в 429 написать, какой потолок и с каким числом исчерпан» даёт оракул для подбора
    // границы; мутация «в 401 тенанта вернуть `session` для отладки» уносит наружу `member_id`.
    const rate = await ask(deps({ allowPortal: () => false }))
    expect(rate.body).toEqual({ ok: false, error: DASHBOARD_RATE_MESSAGE })
    // ⚠️ Строка выше сравнивает текст с ним же — она ловит подмену тела, но не правку самой
    // константы. Поэтому отдельно проверяем СВОЙСТВА: ни числа, ни слова о том, какой потолок
    // сработал. По разнице в тексте подбиралась бы граница.
    expect(DASHBOARD_RATE_MESSAGE, 'в тексте отказа появилось число — это подсказка о потолке')
      .not.toMatch(/\d/)
    expect(DASHBOARD_RATE_MESSAGE, 'текст называет, какой из потолков сработал')
      .not.toMatch(/портал|адрес|потолок|инстанс|лимит/i)

    const gone = await ask(deps({ tenant: async () => ({ ok: false, status: 401 }) }))
    expect(gone.body).toEqual({ ok: false, error: PORTAL_GONE_MESSAGE })

    for (const out of [await ask(deps(), { surveyKey: '' }), await ask(deps({}, fakeStore(RESPONSES, null)))]) {
      expect(out.body.ok).toBe(false)
      expect(typeof out.body.error).toBe('string')
    }
  })

  it('вопроса выбора нет → распределения нет вовсе, а не пустая карточка', async () => {
    // Мутация «инициализировать `distribution` пустым объектом» рисует карточку без заголовка на
    // каждом дашборде, где выбора не спрашивают.
    const noChoice: CompiledVersion = { ...VERSION, questions: VERSION.questions.filter((q) => q.metric !== 'choice') }
    const out = await ask(deps({}, fakeStore(RESPONSES, noChoice)))
    expect(out.body.distribution).toBeNull()
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

  it('?version=N фильтрует и СРЕЗЫ, а не только общее число', async () => {
    // ⚠️ Мутация «считать `breakdownBy` по `allResponses`» делает фильтр по версии декоративным:
    // цифры среза остаются от всех версий, а человек сравнивает «до/после публикации» именно по ним.
    // Единственное, что доказывало фильтрацию, — `body.n`.
    const v3 = Array.from({ length: 6 }, (_, i) => ({
      ...record(300 + i, 'speed', 0, { context: { responsibleId: 9, responsibleName: 'Петров' } }),
      versionNo: 3
    }))
    const out = await ask(deps({}, fakeStore([...RESPONSES, ...v3])), { version: '3' })
    expect((out.body.responsibles as Array<{ name: string }>).map((r) => r.name),
      'в срез попали ответы других версий').toEqual(['Петров'])
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

  it('пер-IP потолка НЕТ — на SSR-пути его ключ был бы один на все порталы (#49)', () => {
    // ⚠️ Страница `/d/:key` рендерится на сервере и зовёт роут внутренним вызовом: сокета у него нет,
    // `clientIp` отдаёт `unknown`. Потолок по такому ключу — общий счётчик на весь сервис, а стоя до
    // гейта сессии, он превращается в неавторизованный отказ дашборда всем арендаторам: `GET
    // /d/что-угодно` раз в секунду выжигает бакет. Возвращать его сюда нельзя — гранулярность на
    // SSR-пути делается доверенным прокси (#148).
    expect(Object.keys(createDashboardLimiter()), 'пер-IP потолок вернулся на роут дашборда')
      .toEqual(['allowPortal'])
  })

  it('окно отпускает через windowMs', () => {
    const lim = createDashboardLimiter({ portalLimit: 2, windowMs: 1000 })
    expect(lim.allowPortal(1, t(0))).toBe(true)
    expect(lim.allowPortal(1, t(1))).toBe(true)
    expect(lim.allowPortal(1, t(2))).toBe(false)
    expect(lim.allowPortal(1, t(1500)), 'окно не отпустило').toBe(true)
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

  it('БОЕВЫЕ дефолты: 60 на портал и 600 на инстанс за минуту', () => {
    // ⚠️ Все тесты выше собирают лимитер со своими опциями — то есть боевой экземпляр из роута
    // (`createDashboardLimiter()` без аргументов) не создаётся нигде. Мутация «поднять дефолты до
    // миллиона и сжать окно до 1 мс» выключает потолок целиком и проходит весь набор.
    const lim = createDashboardLimiter()
    for (let i = 0; i < 60; i++) expect(lim.allowPortal(1, t(i)), `запрос ${i}`).toBe(true)
    expect(lim.allowPortal(1, t(60)), 'пер-портальный дефолт не 60').toBe(false)
    expect(lim.allowPortal(1, t(59_000)), 'окно короче минуты').toBe(false)
    expect(lim.allowPortal(1, t(61_000)), 'окно длиннее минуты').toBe(true)

    const wide = createDashboardLimiter()
    let allowed = 0
    for (let p = 1; p <= 20; p++) for (let i = 0; i < 40; i++) if (wide.allowPortal(p, t(i))) allowed++
    expect(allowed, 'глобальный дефолт не 600').toBe(600)
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

  it('потолок подключён к БОЕВОМУ лимитеру, а не к заглушке', () => {
    expect(src, 'потолок портала отвязан от лимитера').toMatch(/allowPortal:\s*\(\s*portalId\s*\)\s*=>\s*dashboardLimiter\.allowPortal\(\s*portalId\s*\)/)
  })

  it('сессия, тенант и стор подключены к БОЕВЫМ резолверам (#47)', () => {
    // ⚠️ Эти три ушли из-под текстового гарда `admin-gate` вместе с выносом решения: он теперь читает
    // `dashboard-view.ts`, где вызовы есть по построению. Подмена в ПРОВОДКЕ (`tenant: async () => ({
    // ok: true, portalId: 42 })` или `storeFor: () => useStore()`) снимает tenant-изоляцию целиком —
    // сотрудник одного заказчика видит срезы другого с именами клиентов, — и без этих строк не
    // роняет ничего.
    expect(src, 'гейт сессии подменён').toMatch(/session:\s*\(\s*\)\s*=>\s*resolvePortalSession\(\s*event\s*\)/)
    expect(src, 'резолв тенанта подменён').toMatch(/tenant:\s*\(\s*session\s*\)\s*=>\s*resolveSessionPortal\(\s*session\s*\)/)
    expect(src, 'стор берётся мимо портала тенанта').toMatch(/storeFor:\s*\(\s*portalId\s*\)\s*=>\s*storeFor\(\s*portalId\s*\)/)
    expect(src, 'вернулся общий стор на процесс').not.toMatch(/\buseStore\(\)/)
  })

  it('зависимости передаются ЛИТЕРАЛОМ — спред позволил бы перекрыть их после', () => {
    // ⚠️ Гард ищет подстроки. Мутация «поднять зависимости в константу и передать
    // `{ ...wired, allowPortal: () => true }`» оставляет все требуемые строки на месте и выключает
    // потолок. Спред в этом объекте не нужен ни для чего, поэтому проще его запретить.
    const call = src.slice(src.indexOf('dashboardDecision('))
    expect(call, 'в объекте зависимостей появился спред — им перекрывают проверенные строки')
      .not.toMatch(/\.\.\./)
  })

  it('дашборд НЕ читает все ответы в память — ради этого порт и заводился (#49)', () => {
    // ⚠️ Регресс сюда возвращается одной строкой (`store.listResponses(...)` вместо порта) и не
    // роняет ничего: цифры-то те же. А цена — та, из-за которой #49 и открыт: один сотрудник одного
    // портала, зажавший F5 на большом опросе, занимает пул и event loop всем арендаторам.
    const decider = readFileSync(resolve(process.cwd(), 'server/utils/dashboard-view.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    expect(decider, 'вернулось чтение всех ответов в память').not.toMatch(/\blistResponses\(/)
    expect(decider, 'порт агрегатов не используется').toMatch(/store\.dashboardAggregates\(/)
  })

  it('роут НИЧЕГО не решает сам — иначе исполняемые тесты выше проверяют не тот код', () => {
    expect(src, 'решение вернулось в роут мимо `dashboardDecision`').toContain('dashboardDecision(')
    expect(src, 'в роуте появилась своя ветка подавления').not.toContain('meetsAnonymity')
    expect(src, 'в роуте появился свой счёт').not.toMatch(/\b(npsFor|csatFor|breakdownBy|suppressSmallBins|distributionFor|npsTrend)\(/)
  })

  it('отказ по частоте несёт `Retry-After`, и заголовок один на оба потолка', () => {
    // Разный `Retry-After` служил бы оракулом «какой потолок сработал»; без него страница во фрейме
    // не отличает «починится через минуту» от «жать F5, тратя окно».
    expect(src).toMatch(/outcome\.status === 429.*retry-after.*\b60\b/s)
  })

  it('ответ не кэшируется: в теле имена клиентов и сотрудников', () => {
    expect(src).toMatch(/cache-control.*no-store/)
  })
})
