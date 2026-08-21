import { describe, expect, it, vi } from 'vitest'
import { makeInviteIssue, type InviteIssueDeps } from '../server/utils/invite-issue'
import { createKeySerializer } from '../src/api/serial-by-key'
import { MemoryInvitationStore, type InvitationStore } from '../src/api/invitation'
import type { PortalClient, CallResult } from '../src/bitrix24/client'
import type { CrmContext } from '../src/domain/schema'
import { INVITE_ORIGINATOR } from '../src/bitrix24/invite-delivery'

/**
 * Проводка выписки целиком — ИСПОЛНЯЕМАЯ, с фейковым порталом.
 *
 * ⚠️ Пока эта работа жила замыканием внутри `defineEventHandler`, её нельзя было запустить вовсе:
 * тест «гроздь → одно приглашение» в `deal-update.test.ts` подменяет `issue` заглушкой, то есть
 * проверяет проводку ДО неё, а не то, что правило соединено с настоящими REST-вызовами.
 */

/** Фейк портала: помнит созданные дела и отвечает на list/get/update как настоящий. */
/**
 * ⚠️ `latency: true` заставляет фейк уступать очередь ПЕРЕД записью — как настоящий REST. Без этого
 * гонки в тесте не возникает вовсе: тело `make` меняет состояние синхронно, и второй обработчик
 * физически не может влезть в промежуток. Ровно на этом головной тест доставки был зелёным при
 * переходном ключе очереди — он доказывал тайминг двойника, а не код.
 */
function fakePortal(over: { failAdd?: boolean; listReturns?: (f: Record<string, unknown>) => unknown[]; markerAccepted?: boolean; latency?: boolean } = {}) {
  const markerAccepted = over.markerAccepted ?? true
  const activities: Array<Record<string, unknown> & { ID: number; COMPLETED: string; ORIGINATOR_ID?: string; ORIGIN_ID?: string }> = []
  let seq = 0
  const calls: string[] = []
  const make = vi.fn(async (opts: { method: string; params?: Record<string, unknown> }): Promise<CallResult> => {
    calls.push(opts.method)
    if (over.latency) await new Promise((r) => setImmediate(r))
    const p = (opts.params ?? {}) as Record<string, never>
    let result: unknown
    if (opts.method === 'crm.activity.configurable.add') {
      if (over.failAdd) throw new Error('ERROR_WRONG_CONTEXT')
      const fields = (p as unknown as { fields?: { originatorId?: string; originId?: string } }).fields ?? {}
      // ⚠️ Владельца записываем: `findOpenInviteActivities` (#198) ищет по `OWNER_ID`/`OWNER_TYPE_ID`,
      // и без этих полей дело «висит в никуда» — фейк отвечал бы пустотой на верный запрос.
      const owner = (p as unknown as { ownerTypeId?: number; ownerId?: number })
      const row = { ID: ++seq + 100, COMPLETED: 'N', OWNER_TYPE_ID: owner.ownerTypeId, OWNER_ID: owner.ownerId,
        ...(markerAccepted
        ? { ORIGINATOR_ID: fields.originatorId, ORIGIN_ID: fields.originId }
        : {}) }
      activities.push(row)
      result = row.ID
    } else if (opts.method === 'crm.activity.list') {
      const f = (p as unknown as { filter: Record<string, unknown> }).filter
      // ⚠️ Соблюдаем ВЕСЬ фильтр, а не пару полей. Прежний фейк сверял `ORIGINATOR_ID` и `ORIGIN_ID`,
      // а поиск открытых дел по сделке (#198) `ORIGIN_ID` не шлёт вовсе — фейк отвечал бы пустотой
      // на любой такой запрос, и правило «не слать вторую живую ссылку» проходило бы набор
      // выключенным. Ровно эта ошибка двойника уже пропускала «поиск в чужой сделке» в #200.
      result = over.listReturns
        ? over.listReturns(f)
        : activities.filter((a) => Object.entries(f).every(([k, v]) => a[k] === v))
    } else if (opts.method === 'crm.activity.get') {
      result = activities.find((a) => a.ID === (p as unknown as { id: number }).id) ?? null
    } else if (opts.method === 'crm.activity.update') {
      const { id, fields } = p as unknown as { id: number; fields: { ORIGINATOR_ID: string; ORIGIN_ID: string } }
      const row = activities.find((a) => a.ID === id)
      if (row) { row.ORIGINATOR_ID = fields.ORIGINATOR_ID; row.ORIGIN_ID = fields.ORIGIN_ID }
      result = true
    }
    return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
  })
  const client: PortalClient = { actions: { v2: { call: { make } } } }
  return { client, activities, calls }
}

const CONTEXT: CrmContext = { dealId: 759, dealStageId: 'C1:WON' }
const ARGS = {
  surveyKey: 'csat_postdeal',
  title: 'Оценка после сделки',
  versionNo: 2,
  context: CONTEXT,
  ttlMs: undefined,
  now: new Date('2026-08-20T10:05:00Z')
}
const CTX = { transition: { id: '4242', at: new Date('2026-08-20T10:00:00Z') }, memberId: 'm-1' }

/** Шим: тесты говорят про `store`/`invitations`, а деп — резолвер тенанта портала (#49). */
type DepsOver = Omit<Partial<InviteIssueDeps>, 'tenant'> & {
  store?: { hasResponseSince: (...args: never[]) => Promise<boolean> }
  invitations?: InvitationStore
  tenant?: InviteIssueDeps['tenant']
}

function deps(over: DepsOver = {}): InviteIssueDeps & { logs: Array<[string, string, Record<string, unknown>]> } {
  const logs: Array<[string, string, Record<string, unknown>]> = []
  const portal = fakePortal()
  const { store: overStore, invitations: overInvitations, tenant: overTenant, ...rest } = over
  const tenant = {
    store: (overStore ?? { hasResponseSince: () => Promise.resolve(false) }) as Awaited<ReturnType<InviteIssueDeps['tenant']>>['store'],
    invitations: overInvitations ?? new MemoryInvitationStore()
  }
  const base: InviteIssueDeps = {
    portalClient: () => Promise.resolve(portal.client),
    tenant: overTenant ?? (() => Promise.resolve(tenant)),
    serializer: createKeySerializer(),
    baseUrl: 'https://polls.example',
    log: {
      info: (e, f) => logs.push(['info', e, f]),
      warn: (e, f) => logs.push(['warn', e, f])
    },
    ...rest
  }
  return { ...base, logs }
}

describe('выписка приглашения — проводка с фейковым порталом', () => {
  it('первое событие: приглашение + дело + маркер принят', async () => {
    const portal = fakePortal()
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const r = await makeInviteIssue(CTX, d)(ARGS)
    expect(r?.token).toBeTruthy()
    expect(portal.activities).toHaveLength(1)
    const activity = d.logs.find((l) => l[1] === 'b24_invite_activity')
    expect(activity?.[0]).toBe('info')
    expect(activity?.[2]).toMatchObject({ markerFix: 'already', markerVisible: 'yes' })
  })

  it('ГРОЗДЬ из четырёх событий одного перехода → ОДНО дело и ОДНО приглашение', async () => {
    // Ровно дефект #138: менеджер тянет сделку в стадию → портал требует дозаполнить поля →
    // сохранение → автоматизация стадии дописывает своё. Все четыре приходят сюда.
    const portal = fakePortal()
    const invitations = new MemoryInvitationStore()
    const d = deps({ portalClient: () => Promise.resolve(portal.client), invitations })
    const issue = makeInviteIssue(CTX, d)
    const results = await Promise.all([issue(ARGS), issue(ARGS), issue(ARGS), issue(ARGS)])
    expect(portal.activities, 'на один переход создано больше одного дела').toHaveLength(1)
    expect(results.filter(Boolean), 'выписано больше одного приглашения').toHaveLength(1)
    expect(d.logs.filter((l) => l[1] === 'b24_invite_dedup')).toHaveLength(3)
    // ⚠️ Ленивость страховки доказывается СЧЁТОМ вызовов, а не порядком. Мутация «спрашивать про
    // чужие приглашения внутри `findByMarker`» сохраняет порядок и добавляет 2–4 лишних запроса к
    // порталу на каждую гроздь — то есть ровно ту цену, ради отказа от которой второй шаг и сделан
    // ленивым. Ожидаем: 4 поиска по маркеру + 1 контрольный после создания + РОВНО 1 страховочный.
    expect(portal.calls.filter((m) => m === 'crm.activity.list'),
      'страховочный запрос ушёл не один раз — гроздь платит за него').toHaveLength(6)
  })

  it('маркер не принят при создании → дописан, и дело всё равно находится', async () => {
    // `configurable.add` вебхуку недоступен, поэтому «примет ли он поля маркера» до установки
    // неизвестно. Ставка на «примет» стоила бы второго приглашения каждой сделке.
    const portal = fakePortal({ markerAccepted: false })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const issue = makeInviteIssue(CTX, d)
    await issue(ARGS)
    const first = d.logs.find((l) => l[1] === 'b24_invite_activity')
    expect(first?.[2]).toMatchObject({ markerFix: 'repaired', markerVisible: 'yes' })
    expect(await issue(ARGS), 'после починки маркера гроздь снова пробила защиту').toBeUndefined()
  })

  it('поиск НЕ видит созданное дело → предупреждение в логе, а не тишина', async () => {
    // Если `crm.activity.list` не возвращает настраиваемые дела, защита — no-op. Без этой строки в
    // логе она выглядела бы работающей: `markerFix: already` при 2–4 письмах клиенту.
    const portal = fakePortal({ listReturns: () => [] })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    await makeInviteIssue(CTX, d)(ARGS)
    const activity = d.logs.find((l) => l[1] === 'b24_invite_activity')
    expect(activity?.[0]).toBe('warn')
    expect(activity?.[2]).toMatchObject({ markerVisible: 'no' })
  })

  it('создание дела упало → живого токена НЕ остаётся', async () => {
    // Иначе в сторе копилась бы годная ссылка со снимком CRM (там ПДн), которую никто никогда не
    // увидит, — и по одной на каждое событие грозди.
    const portal = fakePortal({ failAdd: true })
    // Перехватываем токен: наружу он не отдаётся (выписка упала), а проверить надо именно его.
    const inner = new MemoryInvitationStore()
    const minted: string[] = []
    const invitations = {
      ...inner,
      create: async (...a: Parameters<MemoryInvitationStore['create']>) => {
        const inv = await inner.create(...a)
        minted.push(inv.token)
        return inv
      },
      peek: (...a: Parameters<MemoryInvitationStore['peek']>) => inner.peek(...a),
      consume: (...a: Parameters<MemoryInvitationStore['consume']>) => inner.consume(...a)
    }
    const d = deps({ portalClient: () => Promise.resolve(portal.client), invitations })
    await expect(makeInviteIssue(CTX, d)(ARGS)).rejects.toThrow('ERROR_WRONG_CONTEXT')
    expect(d.logs.find((l) => l[1] === 'b24_invite_activity_fail')?.[0]).toBe('warn')
    expect(minted, 'токен вообще не выписывался — тест проверяет не то').toHaveLength(1)
    // `peek` отдаёт только ЖИВЫЕ приглашения: погашенный токен → undefined.
    expect(
      await inner.peek(minted[0]!, new Date('2026-08-20T10:06:00Z')),
      'приглашение осталось живым, хотя доставить его нечем'
    ).toBeUndefined()
  })

  it('нет ключа перехода → приглашение НЕ выписывается, и это видно в логе', async () => {
    const invitations = new MemoryInvitationStore()
    const d = deps({ invitations })
    const r = await makeInviteIssue({ transition: {}, memberId: 'm-1' }, d)(ARGS)
    expect(r).toBeUndefined()
    expect(d.logs.find((l) => l[1] === 'b24_invite_undelivered')?.[2])
      .toMatchObject({ reason: 'нет ID перехода' })
  })

  it('нет момента перехода → тоже не выписываем (точка отсчёта «ответил ли» неизвестна)', async () => {
    const d = deps()
    expect(await makeInviteIssue({ transition: { id: '4242' }, memberId: 'm-1' }, d)(ARGS)).toBeUndefined()
    expect(d.logs.find((l) => l[1] === 'b24_invite_undelivered')?.[2])
      .toMatchObject({ reason: 'нет момента перехода' })
  })

  it('клиент ответил после перехода, дело закрыто → молчим', async () => {
    const portal = fakePortal()
    const d = deps({
      portalClient: () => Promise.resolve(portal.client),
      store: { hasResponseSince: () => Promise.resolve(true) }
    })
    const issue = makeInviteIssue(CTX, d)
    await issue(ARGS)
    portal.activities.forEach((a) => { a.COMPLETED = 'Y' })
    expect(await issue(ARGS)).toBeUndefined()
    expect(d.logs.filter((l) => l[1] === 'b24_invite_dedup').at(-1)?.[2]).toMatchObject({ reason: 'answered' })
  })

  it('дело закрыто, ответа нет → зовём снова', async () => {
    const portal = fakePortal()
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const issue = makeInviteIssue(CTX, d)
    await issue(ARGS)
    portal.activities.forEach((a) => { a.COMPLETED = 'Y' })
    expect(await issue(ARGS)).toBeTruthy()
    expect(portal.activities).toHaveLength(2)
  })

  it('РУЧНОЕ приглашение висит открытым → переход второй ссылки НЕ шлёт (#198)', async () => {
    // ⚠️ Единственная боевая точка проводки правила. `test/invite-delivery.test.ts` внедряет
    // `countOpenForDeal` сам — то есть проверяет ФОРМУ, а не то, что роут её действительно
    // заполняет: мутация «`countOpenForDeal: () => Promise.resolve(0)`» выключает правило целиком.
    // Дело здесь помечено маркером РУЧНОГО пути — поиск по маркеру перехода его не видит.
    const portal = fakePortal()
    portal.activities.push({
      ID: 55, COMPLETED: 'N', OWNER_TYPE_ID: 2, OWNER_ID: 759,
      ORIGINATOR_ID: INVITE_ORIGINATOR, ORIGIN_ID: 'manual:1755770000:csat_postdeal'
    })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const issued = await makeInviteIssue(CTX, d)(ARGS)

    expect(issued, 'выписана вторая живая ссылка').toBeUndefined()
    expect(portal.calls, 'дело всё-таки создано').not.toContain('crm.activity.configurable.add')
    const dedup = d.logs.find((l) => l[1] === 'b24_invite_dedup')
    expect(dedup?.[2].reason, 'причина отсечения не названа').toBe('open-other')
  })

  it('ЗАКРЫТОЕ ручное приглашение переход не блокирует', async () => {
    // Иначе одна забытая закрытая задача выключила бы опрос по сделке навсегда.
    const portal = fakePortal()
    portal.activities.push({
      ID: 55, COMPLETED: 'Y', OWNER_TYPE_ID: 2, OWNER_ID: 759,
      ORIGINATOR_ID: INVITE_ORIGINATOR, ORIGIN_ID: 'manual:1755770000:csat_postdeal'
    })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    expect(await makeInviteIssue(CTX, d)(ARGS), 'приглашение не выписано').toBeDefined()
  })

  it('ручное приглашение по ДРУГОМУ опросу переход не блокирует', async () => {
    // Опрос отфильтровывается разбором `ORIGIN_ID`: дело по `nps` не должно гасить приглашение по
    // `csat_postdeal`, висящее на той же сделке.
    const portal = fakePortal()
    portal.activities.push({
      ID: 55, COMPLETED: 'N', OWNER_TYPE_ID: 2, OWNER_ID: 759,
      ORIGINATOR_ID: INVITE_ORIGINATOR, ORIGIN_ID: 'manual:1755770000:nps_quarterly'
    })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    expect(await makeInviteIssue(CTX, d)(ARGS)).toBeDefined()
  })

  it('портал не ответил про чужие приглашения → зовём, но отказ ВИДЕН строкой (#198)', async () => {
    // fail-open: звать клиента — прямая работа этого пути, дедуп здесь страховка. Молчаливый
    // fail-open неотличим от «правило не сработало».
    //
    // ⚠️ Вызовы различаем ПО ФИЛЬТРУ, а не по порядку: поиск по маркеру шлёт `ORIGIN_ID`, страховка —
    // нет. Счётчик «первый/второй» молча инвертировал бы смысл теста, если шаги когда-нибудь
    // переставят местами.
    const portal = fakePortal({
      listReturns: (f) => {
        if (f.ORIGIN_ID !== undefined) return [] // поиск по маркеру отвечает штатно
        throw new Error('портал недоступен') // страховка по сделке падает
      }
    })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    expect(await makeInviteIssue(CTX, d)(ARGS), 'клиента не спросили из-за отказа страховки').toBeDefined()
    const fail = d.logs.find((l) => l[1] === 'b24_invite_open_probe_fail')
    expect(fail, 'отказ страховки прошёл молча').toBeDefined()
    expect(fail?.[0], 'отказ страховки прошёл как обычная строка').toBe('warn')
    expect(fail?.[2].reason, 'режим отказа не назван — таймаут и ошибка чинятся по-разному').toBe('error')
    expect(fail?.[2]).toMatchObject({ surveyKey: ARGS.surveyKey, dealId: 759 })
    // ⚠️ `errInfo`, а не голая ошибка: это барьер скрабинга проекта, а `Error` сериализуется в `{}` —
    // строка осталась бы, причина исчезла.
    expect(JSON.stringify(fail?.[2].err), 'причина отказа потерялась при сериализации').toContain('недоступен')
  })

  it('портал ЗАВИС на страховочном запросе → доставка не ждёт его дольше бюджета (#198)', async () => {
    // ⚠️ Найдено ревью. `.catch` закрывает только мгновенный отказ, а клиент Bitrix24 так не
    // отказывает: свой таймаут ~30 секунд, повторы, backoff. Событийный роут ждёт всю работу до
    // отдачи 200, и Bitrix24 события не повторяет — то есть зависание съедало бы САМУ ДОСТАВКУ, а не
    // страховку. Это ровно тот исход, который решение fail-open объявляет худшим.
    const portal = fakePortal({
      listReturns: (f) => {
        if (f.ORIGIN_ID !== undefined) return []
        throw new Error('unreachable') // подменяется ниже
      }
    })
    // Страховка виснет навсегда; поиск по маркеру отвечает сразу.
    const orig = portal.client.actions.v2.call.make
    portal.client.actions.v2.call.make = (async (opts: Parameters<typeof orig>[0]) => {
      const f = (opts.params as { filter?: Record<string, unknown> })?.filter
      if (opts.method === 'crm.activity.list' && f?.ORIGIN_ID === undefined) {
        return new Promise(() => { /* никогда */ })
      }
      return orig(opts)
    }) as typeof orig

    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    expect(await makeInviteIssue(CTX, d)(ARGS), 'доставка умерла вместе со страховкой').toBeDefined()
    const fail = d.logs.find((l) => l[1] === 'b24_invite_open_probe_fail')
    expect(fail?.[2].reason).toBe('timeout')
  }, 10_000)

  it('ДВА перехода одной сделки одновременно → ОДНА живая ссылка (#198, ключ очереди)', async () => {
    // ⚠️ Единственная боевая точка ключа очереди. Правило «одна живая ссылка» СДЕЛОЧНОЕ, а ключ был
    // переходным — то есть мьютекс существовал только внутри одного перехода. Два перехода одной
    // сделки (протащили через стадию дважды подряд; событие и робот) шли параллельно, оба видели
    // «чужих открытых нет» и оба создавали. Найдено исполнением на ревью.
    // ⚠️ Тест держит ИМЕННО проводку: `deliverInvite` ключ не собирает, он его получает.
    const portal = fakePortal({ latency: true })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const [a, b] = await Promise.all([
      makeInviteIssue({ ...CTX, transition: { id: '4242', at: CTX.transition.at } }, d)(ARGS),
      makeInviteIssue({ ...CTX, transition: { id: '5353', at: CTX.transition.at } }, d)(ARGS)
    ])
    const created = portal.activities.filter((x) => x.ORIGINATOR_ID !== undefined)
    expect(created, 'у клиента две живые ссылки на один опрос').toHaveLength(1)
    expect([a, b].filter(Boolean), 'выписано больше одного приглашения').toHaveLength(1)
  })

  it('своё дело перехода ЗАКРЫТО, а ручное висит открытым → второй ссылки нет (#198)', async () => {
    // ⚠️ Дыра в таблице покрытия, найденная мутацией на ревью: «свои дела закрыты» × «чужие открыты»
    // не проверялось нигде. Правдоподобная правка `openElsewhere - activities.length` («probe считает
    // и наши собственные дела, вычтем их») проходила весь набор — и это ровно дефект #198.
    const portal = fakePortal()
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const issue = makeInviteIssue(CTX, d)
    expect(await issue(ARGS), 'первое приглашение не выписалось').toBeDefined()
    // Менеджер снял задачу с себя, но клиент не отвечал.
    portal.activities.forEach((a) => { a.COMPLETED = 'Y' })
    portal.activities.push({
      ID: 55, COMPLETED: 'N', OWNER_TYPE_ID: 2, OWNER_ID: 759,
      ORIGINATOR_ID: INVITE_ORIGINATOR, ORIGIN_ID: 'manual:1755770000:csat_postdeal'
    })
    expect(await issue(ARGS), 'выписана вторая живая ссылка').toBeUndefined()
  })

  it('у открытого ручного дела ID нечитаем → всё равно НЕ шлём вторую ссылку (#198)', async () => {
    // ⚠️ `findOpenInviteActivities` отдаёт `found` (сколько СТРОК) и `ids` (у скольких читается id) —
    // разные числа, и разница названа несущей: строка без разбираемого id всё равно означает
    // «приглашение уже есть». У ручного пути это закреплено (#176), у автопути не было: мутация
    // проводки `r.found` → `r.ids.length` проходила набор.
    const portal = fakePortal()
    portal.activities.push({
      ID: 'abc' as unknown as number, COMPLETED: 'N', OWNER_TYPE_ID: 2, OWNER_ID: 759,
      ORIGINATOR_ID: INVITE_ORIGINATOR, ORIGIN_ID: 'manual:1755770000:csat_postdeal'
    })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    expect(await makeInviteIssue(CTX, d)(ARGS)).toBeUndefined()
  })

  it('открытое приглашение по ДРУГОЙ сделке переход не блокирует', async () => {
    const portal = fakePortal()
    portal.activities.push({
      ID: 55, COMPLETED: 'N', OWNER_TYPE_ID: 2, OWNER_ID: 999,
      ORIGINATOR_ID: INVITE_ORIGINATOR, ORIGIN_ID: 'manual:1755770000:csat_postdeal'
    })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    expect(await makeInviteIssue(CTX, d)(ARGS)).toBeDefined()
  })

  it('«чужое» — это и ПРОШЛЫЙ ПЕРЕХОД, а не только ручное дело (#198)', async () => {
    // Во всех остальных тестах правила строки помечены `manual:`; форма `stage:` под тот же фильтр
    // обязана попадать так же — иначе второй проход сделки через стадию слал бы вторую ссылку.
    const portal = fakePortal()
    portal.activities.push({
      ID: 55, COMPLETED: 'N', OWNER_TYPE_ID: 2, OWNER_ID: 759,
      ORIGINATOR_ID: INVITE_ORIGINATOR, ORIGIN_ID: 'stage:1111:csat_postdeal'
    })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    expect(await makeInviteIssue(CTX, d)(ARGS), 'вторая живая ссылка на новом переходе').toBeUndefined()
  })

  it('страховка падает на КАЖДОМ событии грозди → дедуп грозди всё равно работает', async () => {
    // ⚠️ Прямо обещано в карте: «дедуп грозди продолжает работать — он на отдельном запросе».
    // Обещание без теста живёт до первой правки.
    const portal = fakePortal({
      listReturns: (f) => {
        if (f.ORIGIN_ID !== undefined) return portal.activities.filter((a) => a.ORIGIN_ID === f.ORIGIN_ID)
        throw new Error('портал недоступен')
      }
    })
    const d = deps({ portalClient: () => Promise.resolve(portal.client) })
    const issue = makeInviteIssue(CTX, d)
    const out = await Promise.all([issue(ARGS), issue(ARGS), issue(ARGS), issue(ARGS)])
    expect(out.filter(Boolean), 'гроздь дала больше одного приглашения').toHaveLength(1)
  })

  it('ключ очереди собирается из ПОРТАЛА, СДЕЛКИ и ОПРОСА (#198)', async () => {
    // ⚠️ Каждая часть куплена дефектом, и ни одна не проверяется исходом — только временем и
    // изоляцией, то есть тем, что тест увидит лишь под нагрузкой:
    //  • портал — ID записей истории стадий у разных порталов совпадают штатно, без него медленный
    //    REST одного арендатора держал бы очередь другому;
    //  • сделка — правило «одна живая ссылка» сделочное, переходный ключ оставлял окно на два
    //    перехода одной сделки (найдено исполнением на ревью);
    //  • опрос — разные опросы одной сделки не должны ждать друг друга.
    // Поэтому ключ сверяется НАПРЯМУЮ: сериализатор внедряется, значит его можно и подслушать.
    const keys: string[] = []
    const inner = createKeySerializer()
    const d = deps({ serializer: { ...inner, run: (k, fn) => { keys.push(k); return inner.run(k, fn) } } })
    await makeInviteIssue(CTX, d)(ARGS)
    expect(keys).toEqual([`m-1:deal:759:${ARGS.surveyKey}`])
  })

  it('ссылка в деле строится от НАСТРОЕННОГО домена приложения', async () => {
    const portal = fakePortal()
    const d = deps({ portalClient: () => Promise.resolve(portal.client), baseUrl: 'https://polls.bx-shef.by' })
    const r = await makeInviteIssue(CTX, d)(ARGS)
    const params = portal.client.actions.v2.call.make as unknown as { mock: { calls: Array<[{ method: string; params: Record<string, unknown> }]> } }
    const add = params.mock.calls.find((c) => c[0].method === 'crm.activity.configurable.add')![0].params
    const layout = (add as { layout: { body: { blocks: { surveyLink: { properties: { value: string } } } } } }).layout
    expect(layout.body.blocks.surveyLink.properties.value)
      .toBe(`https://polls.bx-shef.by/s/csat_postdeal?token=${r!.token}`)
  })
})
