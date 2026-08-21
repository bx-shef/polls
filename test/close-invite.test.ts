import { describe, expect, it, vi } from 'vitest'
import { closeInvite, MAX_CLOSE_PER_ANSWER, type CloseInviteDeps } from '../server/utils/close-invite'
import type { PortalClient, CallResult } from '../src/bitrix24/client'
import type { AnsweredInfo } from '../src/api/handlers'

/**
 * Закрытие дела-приглашения (#177) — ИСПОЛНЯЕМО, с фейковым порталом.
 *
 * ⚠️ Пока модуль резолвил зависимости сам, его нельзя было запустить вовсе: пять ранних выходов,
 * каждый из которых полностью выключает фичу, не проверялись ничем. Плюс покрытие в проекте
 * считается только по `src/**`, то есть `server/**` не гейтится и порогом.
 */
const INFO: AnsweredInfo = {
  surveyKey: 'csat_postdeal',
  surveyTitle: 'Оценка после сделки',
  versionNo: 2,
  responseId: 'r-1',
  lines: [{ label: 'Насколько вероятно?', value: '9' }],
  resultToTimeline: true,
  context: { dealId: 759 },
  at: new Date('2026-08-20T10:00:00Z')
}

/** Фейк портала: помнит дела и честно отвечает на list/update. */
function fakePortal(activities: Array<{ ID: number; ORIGIN_ID?: string }>, over: {
  failUpdate?: (id: number) => boolean
  ignoreUpdate?: boolean
  failList?: boolean
} = {}) {
  const open = new Map(activities.map((a) => [a.ID, a]))
  const calls: string[] = []
  const make = vi.fn(async (opts: { method: string; params?: Record<string, unknown> }): Promise<CallResult> => {
    calls.push(opts.method)
    let result: unknown
    if (opts.method === 'crm.activity.list') {
      if (over.failList) throw new Error('портал недоступен')
      result = [...open.values()]
    } else if (opts.method === 'crm.activity.update') {
      const id = (opts.params as unknown as { id: number }).id
      if (over.failUpdate?.(id)) throw new Error('нет прав')
      // `ignoreUpdate` — портал принял вызов и НИЧЕГО не сделал: настраиваемое дело может не
      // поддерживать `COMPLETED` через `crm.activity.update`, и это вживую не сверено.
      if (!over.ignoreUpdate) open.delete(id)
      result = true
    }
    return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
  })
  const client: PortalClient = { actions: { v2: { call: { make } } } }
  return { client, open, calls }
}

function deps(client: PortalClient | undefined, over: Partial<CloseInviteDeps> = {}) {
  const logs: Array<[string, string, Record<string, unknown>]> = []
  const d: CloseInviteDeps = {
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

const mark = (transition: string, survey = 'csat_postdeal'): string => `stage:${transition}:${survey}`

describe('закрытие дела-приглашения при ответе', () => {
  it('закрывает дела ЭТОЙ сделки по ЭТОМУ опросу', async () => {
    // ⚠️ Третье дело — РУЧНОЕ (#176). Ответ клиента закрывает вопрос по опросу целиком, а не по тому,
    // кто выписал приглашение; без этой строки «ручное дело тоже закрывается» держалось только на
    // юнит-тесте разбора маркера.
    const p = fakePortal([
      { ID: 1, ORIGIN_ID: mark('100') },
      { ID: 2, ORIGIN_ID: mark('200') },
      { ID: 3, ORIGIN_ID: 'manual:1787220000:csat_postdeal' }
    ])
    const d = deps(p.client)
    await closeInvite(INFO, d)
    expect([...p.open.keys()], 'дела не закрылись').toEqual([])
    const line = d.logs.find((l) => l[1] === 'b24_invite_closed')
    expect(line?.[0]).toBe('info')
    expect(line?.[2]).toMatchObject({ found: 3, closed: 3, failed: 0, stillOpen: 0 })
  })

  it('дело ДРУГОГО опроса на той же сделке остаётся открытым', async () => {
    const p = fakePortal([{ ID: 1, ORIGIN_ID: mark('100') }, { ID: 2, ORIGIN_ID: mark('100', 'nps_quarterly') }])
    await closeInvite(INFO, deps(p.client))
    expect([...p.open.keys()], 'закрыто приглашение на другой опрос').toEqual([2])
  })

  it('портал ПРИНЯЛ update и ничего не сделал → warn, а не тихий успех', async () => {
    // ⚠️ Ровно та же ставка, что у маркера: `crm.activity.update` возвращает успех и тогда, когда
    // поле для этого типа дела не поддерживается. Без перечитывания лог рапортовал бы `closed: 1`
    // при висящем деле, и провал был бы НЕОТЛИЧИМ от работы.
    const p = fakePortal([{ ID: 1, ORIGIN_ID: mark('100') }], { ignoreUpdate: true })
    const d = deps(p.client)
    await closeInvite(INFO, d)
    const line = d.logs.find((l) => l[1] === 'b24_invite_closed')
    expect(line?.[0]).toBe('warn')
    expect(line?.[2]).toMatchObject({ closed: 1, stillOpen: 1 })
  })

  it('дел не нашлось → warn: при известной сделке это «мы своих дел не видим»', async () => {
    // `dealId` в снимке бывает только у приглашения из событийного пути, а там дело создаётся вместе
    // с приглашением. Значит ноль — симптом того же риска, что `markerVisible: no` (#138).
    const d = deps(fakePortal([]).client)
    await closeInvite(INFO, d)
    expect(d.logs.find((l) => l[1] === 'b24_invite_closed')?.[0]).toBe('warn')
  })

  it('отказ на одном деле не съедает остальные', async () => {
    const p = fakePortal(
      [{ ID: 1, ORIGIN_ID: mark('100') }, { ID: 2, ORIGIN_ID: mark('200') }],
      { failUpdate: (id) => id === 1 }
    )
    const d = deps(p.client)
    await closeInvite(INFO, d)
    expect([...p.open.keys()], 'второе дело даже не пробовали').toEqual([1])
    expect(d.logs.find((l) => l[1] === 'b24_invite_closed')?.[2]).toMatchObject({ closed: 1, failed: 1 })
  })

  it('больше капа не закрываем за один ответ', async () => {
    const many = Array.from({ length: MAX_CLOSE_PER_ANSWER + 5 }, (_, i) => ({ ID: i + 1, ORIGIN_ID: mark(String(i)) }))
    const p = fakePortal(many)
    const d = deps(p.client)
    await closeInvite(INFO, d)
    expect(p.open.size).toBe(5)
    expect(d.logs.find((l) => l[1] === 'b24_invite_closed')?.[2])
      .toMatchObject({ found: MAX_CLOSE_PER_ANSWER + 5, closed: MAX_CLOSE_PER_ANSWER, capped: MAX_CLOSE_PER_ANSWER })
  })

  it('отказ портала → warn и сброс кэша клиента, наружу НЕ пробрасывается', async () => {
    const p = fakePortal([], { failList: true })
    let dropped = 0
    const d = deps(p.client, { onFailure: () => { dropped++ } })
    await expect(closeInvite(INFO, d)).resolves.toBeUndefined()
    expect(d.logs.find((l) => l[1] === 'b24_invite_close_fail')?.[0]).toBe('warn')
    expect(dropped, 'протухший клиент остался в кэше до рестарта').toBe(1)
  })

  it('в лог отказа идёт РЕДАКТИРОВАННАЯ ошибка, а не сырой текст', async () => {
    // В тексте ошибки драйвера pg бывает строка подключения с паролем; редакция живёт в `errInfo`.
    const p = fakePortal([], { failList: true })
    const d = deps(p.client)
    await closeInvite(INFO, d)
    const fields = d.logs.find((l) => l[1] === 'b24_invite_close_fail')?.[2]
    expect(fields).toHaveProperty('err')
    expect(fields).not.toHaveProperty('detail')
  })

  it('ответ БЕЗ сделки в снимке → в портал не ходим вовсе', async () => {
    const p = fakePortal([{ ID: 1, ORIGIN_ID: mark('100') }])
    const d = deps(p.client)
    await closeInvite({ ...INFO, context: {} }, d)
    expect(p.calls).toEqual([])
    expect(d.logs).toEqual([])
  })

  it('негодный dealId → в портал не ходим (иначе фильтр мог бы захватить чужие сделки)', async () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const p = fakePortal([{ ID: 1, ORIGIN_ID: mark('100') }])
      await closeInvite({ ...INFO, context: { dealId: bad } }, deps(p.client))
      expect(p.calls, String(bad)).toEqual([])
    }
  })

  it('портала нет (не установлен / память) → тихий выход', async () => {
    const d = deps(undefined)
    await closeInvite(INFO, d)
    expect(d.logs).toEqual([])
  })

  it('ДЕДЛАЙН: ответ отпускается, не дожидаясь медленного портала', async () => {
    // ⚠️ Человек, уже заполнивший анкету, висит на «Отправить» ровно столько, сколько живёт портал.
    // У SDK свой таймаут и ретраи — это минуты; прокси режет раньше, и клиент видит «не отправилось»
    // по УЖЕ записанному ответу.
    let release!: () => void
    const slow: PortalClient = {
      actions: { v2: { call: { make: () => new Promise((r) => { release = () => r({
        isSuccess: true, getData: () => ({ result: [], time: {} }), getErrorMessages: () => []
      } as CallResult) }) } } }
    }
    const d = deps(slow, { deadlineMs: 20 })
    const started = Date.now()
    await closeInvite(INFO, d)
    expect(Date.now() - started, 'ответ ждал медленный портал').toBeLessThan(500)
    expect(d.logs.find((l) => l[1] === 'b24_invite_close_timeout')?.[0]).toBe('warn')
    release() // доигрываем фоновую работу, чтобы не течь между тестами
  })
})
