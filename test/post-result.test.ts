import { describe, expect, it, vi } from 'vitest'
import { postResult, type PostResultDeps } from '../server/utils/post-result'
import type { PortalClient, CallResult } from '../src/bitrix24/client'
import type { AnsweredInfo } from '../src/api/handlers'
import { INVITE_ORIGINATOR } from '../src/bitrix24/invite-delivery'

/**
 * Результат опроса в таймлайне сделки (#18) — ИСПОЛНЯЕМО, с фейковым порталом.
 *
 * ⚠️ Как и у соседнего закрытия дела: внутри четыре ранних выхода, каждый полностью выключает фичу,
 * а `server/**` в проекте порогом покрытия не гейтится. Без этого файла «результат не доехал» и
 * «результат отключён» неразличимы.
 */
const INFO: AnsweredInfo = {
  surveyKey: 'csat_postdeal',
  surveyTitle: 'Оценка после сделки',
  versionNo: 2,
  responseId: 'r-42',
  lines: [
    { label: 'Насколько вероятно, что порекомендуете?', value: '9' },
    { label: 'Что понравилось?', value: 'Скорость' }
  ],
  resultToTimeline: true,
  context: { dealId: 759, responsibleId: 5 },
  at: new Date('2026-08-20T10:00:00Z')
}

/**
 * Фейк портала: помнит созданные дела и честно отвечает на add/get/update.
 *
 * ⚠️ Имена полей РАЗНЫЕ по слоям, и это не придирка: `configurable.add` принимает `fields.originatorId`
 * (camelCase), а `crm.activity.get` отдаёт `ORIGINATOR_ID`. Ровно из-за этого расхождения и
 * существует `ensureActivityMarker` — фейк, сглаживающий его, проверял бы не то.
 */
function fakePortal(over: { failAdd?: boolean; dropMarker?: boolean; deaf?: boolean } = {}) {
  const created: Array<Record<string, unknown>> = []
  const calls: string[] = []
  let nextId = 100
  const make = vi.fn(async (opts: { method: string; params?: Record<string, unknown> }): Promise<CallResult> => {
    calls.push(opts.method)
    let result: unknown
    if (opts.method === 'crm.activity.configurable.add') {
      if (over.failAdd) throw new Error('портал недоступен')
      const fields = (opts.params as { fields?: Record<string, unknown> }).fields ?? {}
      const id = nextId++
      // `dropMarker` — портал принял вызов и маркер НЕ сохранил: принимает ли `configurable.add`
      // поля маркера в своём `fields`, вживую не сверено.
      created.push({
        ID: id,
        COMPLETED: fields.completed,
        RESPONSIBLE_ID: fields.responsibleId,
        ...(over.dropMarker ? {} : { ORIGINATOR_ID: fields.originatorId, ORIGIN_ID: fields.originId })
      })
      result = id
    } else if (opts.method === 'crm.activity.get') {
      const id = (opts.params as unknown as { id: number }).id
      result = created.find((c) => c.ID === id) ?? null
    } else if (opts.method === 'crm.activity.update') {
      const p = opts.params as unknown as { id: number; fields: Record<string, unknown> }
      const row = created.find((c) => c.ID === p.id)
      // `deaf` — портал принял update и НИЧЕГО не сделал (поле не поддержано для этого типа дела).
      if (row && !over.deaf) Object.assign(row, p.fields)
      result = true
    }
    return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
  })
  const client: PortalClient = { actions: { v2: { call: { make } } } }
  return { client, created, calls }
}

function deps(client: PortalClient | undefined, over: Partial<PostResultDeps> = {}) {
  const logs: Array<[string, string, Record<string, unknown>]> = []
  const d: PostResultDeps = {
    portalClient: () => Promise.resolve(client),
    log: {
      info: (e, f) => logs.push(['info', e, f]),
      warn: (e, f) => logs.push(['warn', e, f])
    },
    deadlineMs: 5000,
    ...over
  }
  return { ...d, logs }
}

describe('результат опроса в таймлайне сделки', () => {
  it('создаёт дело со сводкой ответов и маркером записи', async () => {
    const portal = fakePortal()
    const d = deps(portal.client)
    await postResult(INFO, d)

    expect(portal.created).toHaveLength(1)
    const activity = portal.created[0]!
    expect(activity.ORIGINATOR_ID).toBe(INVITE_ORIGINATOR)
    expect(activity.ORIGIN_ID, 'ключ — запись ответа, а не сделка').toBe('result:r-42')
    // Дело-ЗАПИСЬ, а не призыв к действию: незакрытое висело бы вечной задачей у менеджера.
    expect(activity.COMPLETED).toBe('Y')
    expect(activity.RESPONSIBLE_ID).toBe(5)
    expect(d.logs.some(([lvl, e, f]) => lvl === 'info' && e === 'b24_result_posted' && f.lines === 2)).toBe(true)
  })

  it('опрос обещал анонимность → в портал не ходим, и это ВИДНО в логе', async () => {
    // ⚠️ Дело в таймлайне показывает менеджеру, что ответил ИМЕННО ЭТОТ клиент по ИМЕННО ЭТОЙ сделке
    // — качественно другое раскрытие, чем агрегаты дашборда с подавлением малых выборок. Молчаливый
    // пропуск здесь неотличим от «фича сломалась», поэтому отказ пишется строкой.
    const portal = fakePortal()
    const d = deps(portal.client)
    await postResult({ ...INFO, resultToTimeline: false }, d)
    expect(portal.calls, 'результат ушёл в карточку вопреки настройке опроса').toEqual([])
    expect(d.logs.some(([lvl, e]) => lvl === 'info' && e === 'b24_result_skipped')).toBe(true)
  })

  it('ответ БЕЗ сделки в снимке → в портал не ходим вовсе', async () => {
    // Публичная ссылка без приглашения сделки не несёт. Записывать некуда, и это норма: такой ответ
    // живёт в аналитике, а не в карточке.
    const portal = fakePortal()
    await postResult({ ...INFO, context: {} }, deps(portal.client))
    expect(portal.calls).toEqual([])
  })

  it('негодный dealId → в портал не ходим (иначе дело легло бы не туда)', async () => {
    const portal = fakePortal()
    for (const dealId of [0, -1, 1.5, Number.NaN]) {
      await postResult({ ...INFO, context: { dealId } }, deps(portal.client))
    }
    expect(portal.calls).toEqual([])
  })

  it('портала нет (не установлен / память) → тихий выход', async () => {
    const d = deps(undefined)
    await postResult(INFO, d)
    expect(d.logs).toEqual([])
  })

  it('портал принял создание, но маркер НЕ сохранил → дописываем и говорим об этом', async () => {
    const portal = fakePortal({ dropMarker: true })
    const d = deps(portal.client)
    await postResult(INFO, d)
    // Маркер дописан вторым вызовом — иначе повторная запись этот результат не узнает.
    expect(portal.created[0]!.ORIGIN_ID).toBe('result:r-42')
    const posted = d.logs.find(([, e]) => e === 'b24_result_posted')
    expect(posted?.[2].markerFix).toBe('repaired')
  })

  it('портал ПРИНЯЛ дописывание маркера и ничего не сделал → warn, а не тихий успех', async () => {
    // Без перечитывания лог рапортовал бы `repaired` там, где дела с маркером нет, — то есть провал
    // страховки был бы неотличим в логе от её работы.
    const portal = fakePortal({ dropMarker: true, deaf: true })
    const d = deps(portal.client)
    await postResult(INFO, d)
    const posted = d.logs.find(([, e]) => e === 'b24_result_posted')
    expect(posted?.[0]).toBe('warn')
    expect(posted?.[2].markerFix).toBe('failed')
  })

  it('отказ портала → warn и сброс кэша клиента, наружу НЕ пробрасывается', async () => {
    // Ответ клиента дороже записи в CRM: заставить его заполнять анкету заново из-за недоступного
    // портала — худшее, что тут можно сделать.
    const onFailure = vi.fn()
    const d = deps(fakePortal({ failAdd: true }).client, { onFailure })
    await expect(postResult(INFO, d)).resolves.toBeUndefined()
    expect(onFailure).toHaveBeenCalled()
    expect(d.logs.some(([lvl, e]) => lvl === 'warn' && e === 'b24_result_post_fail')).toBe(true)
  })

  it('в лог отказа идёт РЕДАКТИРОВАННАЯ ошибка, а не сырой текст', async () => {
    // Строку инициирует неавторизованный запрос, а в ошибке драйвера бывает строка подключения.
    const client: PortalClient = {
      actions: { v2: { call: { make: async () => { throw new Error('postgres://user:hunter2@db/polls') } } } }
    }
    const d = deps(client)
    await postResult(INFO, d)
    const fail = d.logs.find(([, e]) => e === 'b24_result_post_fail')
    expect(JSON.stringify(fail?.[2])).not.toContain('hunter2')
  })

  it('ДЕДЛАЙН: ответ отпускается, не дожидаясь медленного портала', async () => {
    const slow: PortalClient = {
      actions: { v2: { call: { make: () => new Promise(() => { /* никогда */ }) } } }
    }
    const d = deps(slow, { deadlineMs: 20 })
    await postResult(INFO, d)
    expect(d.logs.some(([lvl, e]) => lvl === 'warn' && e === 'b24_result_post_timeout')).toBe(true)
  })
})
