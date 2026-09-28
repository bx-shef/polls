import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Обработчик отзыва ссылки: `server/api/portal/revoke.post.ts`.
 *
 * ⚠ Заведён панелью ревью PR #93. С ревизии 5 стадию элемента двигает в канбане любой сотрудник,
 * и отзыв перестал опираться на неё: «пройдена» — по дате прохождения, «отозвана» — по нашей строке.
 * Здесь держится то, что стоит данных клиента: пройденный опрос не помечается отозванным, даже
 * когда база и портал разошлись, а перетащенная в «Отозвана» живая ссылка всё ещё гасится.
 *
 * Роут импортируется напрямую, сессия, портал и база подделаны — приём и его история
 * в `survey-result-api.test.ts`.
 */

const SURVEY = { entityTypeId: 1040, id: 10, categoryId: 16 }
const DEAL = 2
const ITEM = 54

interface Probe {
  portalCalls: { method: string, params: Record<string, unknown> }[]
  revoked: number[]
}

let probe: Probe
let item: Record<string, unknown>
let linkStatus: string | null
let revokedRows: number

async function loadHandler() {
  probe = { portalCalls: [], revoked: [] }

  vi.doMock('../../server/api/portal/-session', () => ({
    openPortalSession: async () => ({
      portal: { id: 'портал', domain: 'shef.bitrix24.ru' },
      userId: 3,
      authId: 'фреймовый-токен',
      call: async (method: string, params: Record<string, unknown> = {}) => {
        probe.portalCalls.push({ method, params })
        if (method === 'crm.item.list') return { result: { items: [item] } }
        return { result: { item: { id: ITEM } } }
      },
    }),
  }))
  vi.doMock('../../server/b24/frame-auth', () => ({ verifyDealAccess: async () => ({ ok: true }) }))
  vi.doMock('../../server/b24/provision', () => ({ readStoredRefs: async () => ({ survey: SURVEY }) }))
  vi.doMock('../../server/links/issue', () => ({
    readLinkStatuses: async (_portal: string, ids: readonly number[]) =>
      new Map(linkStatus === null ? [] : ids.map(id => [id, linkStatus] as const)),
    revokeLink: async (_portal: string, itemId: number) => {
      probe.revoked.push(itemId)
      return revokedRows
    },
  }))
  vi.doMock('../../server/utils/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))
  vi.doMock('h3', async () => {
    const actual = await vi.importActual<typeof import('h3')>('h3')
    return { ...actual, readBody: async () => ({ dealId: DEAL, itemId: ITEM }) }
  })
  vi.resetModules()

  const { default: handler } = await import('../../server/api/portal/revoke.post')
  return (handler as unknown as (event: unknown) => Promise<Record<string, unknown>>)
}

const stageWrites = () => probe.portalCalls.filter(one => one.method === 'crm.item.update')

beforeEach(() => {
  item = {
    id: ITEM,
    stageId: 'DT1040_16:NEW',
    UF_CRM_10_TEMPLATE_CODE: 'brand',
    UF_CRM_10_EXPIRES_AT: '2099-01-01T00:00:00+03:00',
    UF_CRM_10_COMPLETED_AT: '',
  }
  linkStatus = 'sent'
  revokedRows = 1
})

afterEach(() => {
  for (const path of [
    '../../server/api/portal/-session',
    '../../server/b24/frame-auth',
    '../../server/b24/provision',
    '../../server/links/issue',
    '../../server/utils/logger',
    'h3',
  ]) vi.doUnmock(path)
  vi.resetModules()
})

describe('отзыв ссылки', () => {
  it('живую гасит у нас и ставит «Отозвана» на портале', async () => {
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true })
    expect(probe.revoked).toEqual([ITEM])
    expect(stageWrites().map(one => one.params.fields)).toEqual([{ stageId: 'DT1040_16:FAIL' }])
  })

  it('ГЛАВНОЕ: база не погасила ни строки — «Отозвана» на портал не пишется', async () => {
    // ⚠ Ноль строк — ответ уже принят (гонка с прохождением) или строки нет. Написав «Отозвана»
    // после отказа базы, мы пометили бы пройденный опрос отозванным навсегда: доставка, которая
    // уже прошла, назад его не переведёт. Нашла безопасность в панели PR #93.
    revokedRows = 0
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-revocable' })
    expect(stageWrites()).toEqual([])
  })

  it('ГЛАВНОЕ: перетащенная в «Отозвана» живая ссылка всё ещё гасится', async () => {
    // ⚠ Стадию двигают в канбане, а страницу закрывает наша строка. Поверив стадии, вкладка
    // спрятала бы кнопку, и ссылку, которую менеджер считает погашенной, клиент прошёл бы.
    item = { ...item, stageId: 'DT1040_16:FAIL' }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true })
    expect(probe.revoked).toEqual([ITEM])
  })

  it('ГЛАВНОЕ: пройденную по дате прохождения не гасит, в какой бы стадии она ни стояла', async () => {
    // Клиент увёл пройденный опрос в свою стадию — это не повод объявить ответ несостоявшимся.
    item = { ...item, stageId: 'DT1040_16:PROCESSED', UF_CRM_10_COMPLETED_AT: '2026-09-20T03:00:00+03:00' }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-revocable' })
    expect(probe.revoked).toEqual([])
    expect(stageWrites()).toEqual([])
  })

  it('уже отозванную базой второй раз не гасит', async () => {
    linkStatus = 'revoked'
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-revocable' })
    expect(probe.revoked).toEqual([])
  })
})
