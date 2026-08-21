import { describe, expect, it, vi } from 'vitest'
import { manualInvite, MAX_EXISTING_IDS, type ManualInviteDeps } from '../server/utils/manual-invite'
import { MemoryInvitationStore } from '../src/api/invitation'
import { INVITE_ORIGINATOR, markerMatchesSurvey } from '../src/bitrix24/invite-delivery'
import { DEAL_OWNER_TYPE_ID } from '../src/bitrix24/activity'
import type { PortalClient, CallResult } from '../src/bitrix24/client'
import type { CompiledVersion, CrmContext } from '../src/domain/schema'
import type { IStore } from '../src/store/types'

/**
 * Ручной запуск опроса из карточки сделки (#176) — ИСПОЛНЯЕМО, с фейковым порталом.
 *
 * Проверяется ПОВЕДЕНИЕ, а не форма: «висит открытое дело → второй ссылки нет», «force создаёт
 * осознанно», «отказ создания дела НЕ отбирает у человека уже выданную ссылку». Покрытие в проекте
 * считается только по `src/**`, то есть `server/**` порогом не гейтится вовсе.
 */
const CONTEXT: CrmContext = { dealId: 759, responsibleId: 12 }
const SURVEY = 'csat_postdeal'

/** Фейк портала: помнит дела, честно отвечает на list/add/get/update. */
function fakePortal(existing: Array<Record<string, unknown>> = [], over: {
  failAdd?: boolean
  failList?: boolean
  /** `configurable.add` принял вызов, но поля маркера проигнорировал (вживую не сверено). */
  dropMarker?: boolean
  /** `crm.activity.update` отказывает — тогда маркер дописать не выйдет (`markerFix: 'failed'`). */
  failUpdate?: boolean
} = {}) {
  const rows = new Map(existing.map((a) => [a.ID as number, { COMPLETED: 'N', ...a }]))
  let nextId = 1000
  const calls: string[] = []
  /** Параметры вызовов — параллельно `calls`: без них содержимое созданного дела не проверить. */
  const params: Array<Record<string, unknown> | undefined> = []
  const make = vi.fn(async (opts: { method: string; params?: Record<string, unknown> }): Promise<CallResult> => {
    calls.push(opts.method)
    params.push(opts.params)
    let result: unknown
    if (opts.method === 'crm.activity.list') {
      if (over.failList) throw new Error('портал недоступен')
      // ⚠️ Фейк уважает ВЕСЬ фильтр, а не только `COMPLETED`. Пока он игнорировал `OWNER_ID` и
      // `ORIGINATOR_ID`, мутация «убрать привязку к сделке» оставляла тесты зелёными — то есть тест
      // называл привязку несущей и её же не проверял.
      const f = (opts.params as { filter?: Record<string, unknown> } | undefined)?.filter ?? {}
      result = [...rows.values()].filter((r) =>
        Object.entries(f).every(([k, v]) => v === undefined || r[k] === v))
    } else if (opts.method === 'crm.activity.configurable.add') {
      if (over.failAdd) throw new Error('нет прав на дела')
      const p = opts.params as { fields?: Record<string, unknown>; ownerId?: number; ownerTypeId?: number }
      const id = nextId++
      // ⚠️ Владельца записываем ОБА поля, как это делает портал: без `OWNER_TYPE_ID` только что
      // созданное дело не попадало бы под наш же фильтр, и фейк молча «чинил» бы дедуп.
      rows.set(id, {
        ID: id,
        COMPLETED: 'N',
        OWNER_ID: p.ownerId,
        OWNER_TYPE_ID: p.ownerTypeId,
        ...(over.dropMarker ? {} : { ORIGINATOR_ID: p.fields?.originatorId, ORIGIN_ID: p.fields?.originId })
      })
      result = id
    } else if (opts.method === 'crm.activity.get') {
      result = rows.get((opts.params as { id: number }).id) ?? null
    } else if (opts.method === 'crm.activity.update') {
      if (over.failUpdate) throw new Error('правка дела запрещена')
      const p = opts.params as { id: number; fields: Record<string, unknown> }
      Object.assign(rows.get(p.id) ?? {}, p.fields)
      result = true
    }
    return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
  })
  const client: PortalClient = { actions: { v2: { call: { make } } } }
  return { client, rows, calls, params }
}

const version = { versionNo: 2, title: 'Оценка после сделки' } as CompiledVersion
type ManualStore = Pick<IStore, 'currentVersion' | 'hasResponseSince'>
const store = (answered = false): ManualStore => ({
  currentVersion: async () => version,
  hasResponseSince: async () => answered
})
const noVersion: ManualStore = { currentVersion: async () => undefined, hasResponseSince: async () => false }

function deps(client: PortalClient, over: Partial<ManualInviteDeps> = {}) {
  const logs: Array<[string, string, Record<string, unknown>]> = []
  const d: ManualInviteDeps = {
    client,
    portalId: 'member-id-fake-0000000000000000',
    store: store(),
    invitations: new MemoryInvitationStore(),
    baseUrl: 'https://polls.example.com',
    log: { info: (e, f) => logs.push(['info', e, f]), warn: (e, f) => logs.push(['warn', e, f]) },
    now: new Date('2026-08-21T10:00:00.000Z'),
    ...over
  }
  return { ...d, logs }
}

const row = (id: number, originId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ID: id,
  ORIGINATOR_ID: INVITE_ORIGINATOR,
  OWNER_TYPE_ID: DEAL_OWNER_TYPE_ID,
  OWNER_ID: 759,
  ORIGIN_ID: originId,
  COMPLETED: 'N',
  ...over
})

describe('ручной запуск из карточки сделки: «уже приглашали?» (#176)', () => {
  it('открытое дело по ЭТОМУ опросу → второй ссылки нет', async () => {
    // ⚠️ Ровно тот дефект задачи: менеджер не заметил блок в таймлайне и нажал «Создать ссылку».
    const p = fakePortal([row(7, `stage:100:${SURVEY}`)])
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    expect(res).toEqual({ kind: 'existing', activityIds: [7], surveyTitle: 'Оценка после сделки' })
    expect(p.calls, 'выписка всё-таки пошла').not.toContain('crm.activity.configurable.add')
    // ⚠️ Имя опроса — не украшение: без него человека некуда вести, кроме «куда-то в таймлайн», и
    // правильный путь становится дороже неправильного (кнопка обхода стоит одно нажатие рядом).
    expect(d.logs.find((l) => l[1] === 'b24_manual_dedup')?.[2]).toMatchObject({ found: 1, activityIds: [7] })
  })

  it('дедуп привязан к СДЕЛКЕ: дело в чужой сделке не считается', async () => {
    // ⚠️ Без привязки к владельцу подложенное (или просто чужое) дело выключало бы опрос по любой
    // сделке портала. Фейк портала уважает весь фильтр, поэтому мутация «убрать OWNER_ID» видна.
    const p = fakePortal([row(7, `stage:100:${SURVEY}`, { OWNER_ID: 760 })])
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client))
    expect(res.kind).toBe('created')
  })

  it('строка БЕЗ читаемого id всё равно означает «приглашение уже есть»', async () => {
    // ⚠️ Дедуп решает по `found`, а не по длине списка id: выбросив такую строку, он пригласил бы
    // второй раз. У соседнего `activityListByMarker` этот разбор записан прямо, и здесь он повторён.
    const p = fakePortal([row(7, `stage:100:${SURVEY}`, { ID: 'не-число' })])
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client))
    expect(res.kind).toBe('existing')
    if (res.kind !== 'existing') throw new Error('unreachable')
    expect(res.activityIds).toEqual([])
  })

  it('клиент УЖЕ ОТВЕТИЛ → говорим об этом, хотя открытых дел нет', async () => {
    // ⚠️ Дело закрывается ответом клиента (#177), значит «открытых дел нет» ≠ «не приглашали».
    // Без этой ветки следующее нажатие молча выписывало новую ссылку по уже отвеченной сделке —
    // и оцениваемый сотрудник мог заполнить анкету за клиента после низкой оценки.
    const p = fakePortal([row(7, `stage:100:${SURVEY}`, { COMPLETED: 'Y' })])
    const d = deps(p.client, { store: store(true) })
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    expect(res).toEqual({ kind: 'answered', surveyTitle: 'Оценка после сделки' })
    expect(p.calls).not.toContain('crm.activity.configurable.add')
    expect(d.logs.find((l) => l[1] === 'b24_manual_answered')).toBeDefined()
  })

  it('force проходит и мимо «клиент уже ответил» — спросить ещё раз законно', async () => {
    const p = fakePortal()
    const res = await manualInvite(
      { dealId: 759, surveyKey: SURVEY, context: CONTEXT, force: true },
      deps(p.client, { store: store(true) })
    )
    expect(res.kind).toBe('created')
  })

  it('отказ СВОЕЙ базы на вопросе «отвечал ли» не запирает человека', async () => {
    const p = fakePortal()
    const d = deps(p.client, {
      store: { currentVersion: async () => version, hasResponseSince: async () => { throw new Error('БД недоступна') } }
    })
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    expect(res.kind).toBe('created')
  })

  it('видит и АВТОМАТИЧЕСКОЕ дело, и созданное РУКАМИ — иначе пути слепы друг к другу', async () => {
    for (const originId of [`stage:100:${SURVEY}`, `manual:1787220000:${SURVEY}`]) {
      const p = fakePortal([row(7, originId)])
      const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client))
      expect(res.kind, originId).toBe('existing')
    }
  })

  it('дело по ДРУГОМУ опросу и ЗАКРЫТОЕ дело не мешают: это не тот повод', async () => {
    const p = fakePortal([row(7, 'stage:100:nps'), row(8, `stage:101:${SURVEY}`, { COMPLETED: 'Y' })])
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client))
    expect(res.kind).toBe('created')
  })

  it('дело-РЕЗУЛЬТАТ не читается как приглашение', async () => {
    // Префиксы разведены намеренно: совпади они, запись о результате гасила бы новый опрос.
    // ⚠️ Форма ТРЁХЧАСТНАЯ намеренно: `result:r-1` не совпал бы ни при какой реализации (разделитель
    // всего один), и тест обещал бы больше, чем проверяет. Здесь мутация «добавить `result:` в список
    // префиксов приглашения» обязана краснеть.
    const p = fakePortal([row(7, 'result:4242:' + SURVEY)])
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client))
    expect(res.kind).toBe('created')
  })

  it('force → выписываем ОСОЗНАННО, даже когда дело висит', async () => {
    const p = fakePortal([row(7, `stage:100:${SURVEY}`)])
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT, force: true }, deps(p.client))
    expect(res.kind).toBe('created')
    // ⚠️ И поиска быть не должно: при `force` его ответ ничего не меняет, а REST портала не бесплатен.
    expect(p.calls).not.toContain('crm.activity.list')
  })

  it('отказ ПОИСКА не запирает человека: выписываем, но говорим об этом в лог', async () => {
    // Упереть осознанное действие в недоступность CRM хуже, чем изредка допустить дубль, который
    // менеджер видит своими глазами в той же карточке.
    const p = fakePortal([], { failList: true })
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    expect(res.kind).toBe('created')
    expect(d.logs.find((l) => l[1] === 'b24_manual_lookup_fail')?.[0]).toBe('warn')
  })
})

describe('ручной запуск: что именно создаётся (#176)', () => {
  it('приглашение + дело в таймлайне с маркером `manual:`, и маркер узнаётся своими же', async () => {
    const p = fakePortal()
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    if (res.kind !== 'created') throw new Error('unreachable')
    expect(res.url).toBe(`https://polls.example.com/s/${SURVEY}?token=${res.token}`)
    expect(await d.invitations.peek(res.token, new Date('2026-08-21T10:00:01Z'))).toBeDefined()

    const created = [...p.rows.values()].find((r) => r.ID === res.activityId)
    expect(created?.OWNER_ID, 'дело село не в ту сделку').toBe(759)
    expect(created?.ORIGINATOR_ID).toBe(INVITE_ORIGINATOR)
    // ⚠️ Несущее: не узнавай мы свой ручной маркер, дело не участвовало бы ни в дедупе следующего
    // нажатия, ни в закрытии при ответе (#177) — висело бы в карточке открытым вечно.
    expect(markerMatchesSurvey(created?.ORIGIN_ID, SURVEY)).toBe(true)
    expect(String(created?.ORIGIN_ID)).toMatch(/^manual:\d+:csat_postdeal$/)

    // ⚠️ СОДЕРЖИМОЕ дела, а не только его маркер. Без этого мутация «в шапку чужой заголовок, в тело
    // пустая ссылка, в кнопку чужой токен» проходила весь набор: менеджер получал дело с нерабочей
    // ссылкой, а кнопка «Отправить приглашение» уносила клиенту недействительный токен.
    const add = p.calls.indexOf('crm.activity.configurable.add')
    expect(add).toBeGreaterThanOrEqual(0)
    const params = p.params[add] as {
      layout: { header: { title: string }; body: { blocks: Record<string, { properties: { value: string } }> } }
    }
    expect(params.layout.header.title).toContain('Оценка после сделки')
    expect(params.layout.body.blocks.surveyLink?.properties.value).toBe(res.url)

    // ⚠️ `already`, а не «любой успех»: маркер обязан уходить в САМ `configurable.add`. Забудь мы его
    // там — `ensureActivityMarker` всё дочинил бы, и единственным следом остался бы лишний REST на
    // каждое создание плюс полная зависимость от того, что правка дела разрешена.
    expect(d.logs.find((l) => l[1] === 'b24_manual_activity')?.[2].markerFix).toBe('already')
  })

  it('маркер дописать НЕ вышло → это warn и `failed`, а не тихий успех', async () => {
    // ⚠️ Единственный сигнал о том, что дедуп ручного пути сломан: дело без маркера не найдёт ни
    // следующее нажатие, ни закрытие по ответу. Выдай мы отказ за `already` — провал защиты стал бы
    // неотличим от её работы, ровно как это было до перечитывания в `ensureActivityMarker`.
    const p = fakePortal([], { dropMarker: true, failUpdate: true })
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    expect(res.kind).toBe('created')
    const line = d.logs.find((l) => l[1] === 'b24_manual_activity')
    expect(line?.[2].markerFix, 'провал маркера выдан за успех').toBe('failed')
    expect(line?.[0], 'дедуп сломан, а в логе это info').toBe('warn')
  })

  it('список id капается: десяток дел означает поломку, а не нагрузку', async () => {
    const many = Array.from({ length: 14 }, (_, i) => row(100 + i, `stage:${i}:${SURVEY}`))
    const res = await manualInvite(
      { dealId: 759, surveyKey: SURVEY, context: CONTEXT },
      deps(fakePortal(many).client)
    )
    if (res.kind !== 'existing') throw new Error('unreachable')
    expect(res.activityIds).toHaveLength(MAX_EXISTING_IDS)
  })

  it('маркер, не принятый `configurable.add`, ДОПИСЫВАЕТСЯ — иначе дело не найдётся никем', async () => {
    const p = fakePortal([], { dropMarker: true })
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    if (res.kind !== 'created') throw new Error('unreachable')
    expect(markerMatchesSurvey([...p.rows.values()].find((r) => r.ID === res.activityId)?.ORIGIN_ID, SURVEY)).toBe(true)
    expect(d.logs.find((l) => l[1] === 'b24_manual_activity')?.[2].markerFix).toBe('repaired')
  })

  it('отказ создания ДЕЛА не отбирает у человека ссылку — она уже едет ему ответом', async () => {
    // ⚠️ Единственное отличие от автопути, и оно осознанное: там дело И ЕСТЬ канал доставки, поэтому
    // при отказе токен гасится (ссылка без дела недостижима никому). Здесь ссылку получает менеджер
    // в самом виджете — гасить её значило бы отобрать сделанную работу из-за неудавшейся отметки.
    const p = fakePortal([], { failAdd: true })
    const d = deps(p.client)
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    if (res.kind !== 'created') throw new Error('unreachable')
    expect(res.activityId).toBeUndefined()
    expect(await d.invitations.peek(res.token, new Date('2026-08-21T10:00:01Z')), 'токен погашен').toBeDefined()
    expect(d.logs.find((l) => l[1] === 'b24_manual_activity_fail')?.[0]).toBe('warn')
  })

  it('обход дедупа ИЗМЕРИМ: в логе видно, форсировано ли и почему', async () => {
    // ⚠️ Без этого живой прогон (#126) не отличит «дедуп сработал» от «дедуп обошли», а именно это и
    // надо измерить. `forced` без причины смешал бы законную перевыписку мёртвой ссылки с обходом.
    const plain = deps(fakePortal().client)
    await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, plain)
    expect(plain.logs.find((l) => l[1] === 'b24_manual_activity')?.[2]).toMatchObject({ forced: false })

    const forced = deps(fakePortal().client)
    await manualInvite(
      { dealId: 759, surveyKey: SURVEY, context: CONTEXT, force: true, forceReason: 'dedup' },
      forced
    )
    expect(forced.logs.find((l) => l[1] === 'b24_manual_activity')?.[2])
      .toMatchObject({ forced: true, forceReason: 'dedup' })
  })

  it('два одновременных нажатия дают ОДНО приглашение: «поиск → создание» под очередью', async () => {
    // ⚠️ Кнопка гаснет только внутри одного виджета; два открытых окна или два сотрудника на одной
    // сделке проходили гейт оба. На автопути этот зазор закрыт очередью с #138, здесь его не было.
    const p = fakePortal()
    const d = deps(p.client)
    const [a, b] = await Promise.all([
      manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d),
      manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, d)
    ])
    const kinds = [a!.kind, b!.kind].sort()
    expect(kinds).toEqual(['created', 'existing'])
    expect(p.calls.filter((c) => c === 'crm.activity.configurable.add')).toHaveLength(1)
  })

  it('нет опубликованной версии → ничего не создано и ничего не записано в таймлайн', async () => {
    const p = fakePortal()
    const res = await manualInvite({ dealId: 759, surveyKey: SURVEY, context: CONTEXT }, deps(p.client, { store: noVersion }))
    expect(res).toEqual({ kind: 'unpublished' })
    expect(p.calls).not.toContain('crm.activity.configurable.add')
  })
})
