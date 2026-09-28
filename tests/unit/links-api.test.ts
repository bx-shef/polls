import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortalError } from '../../server/domain/portals/portal-error'

/**
 * Обработчик списка ссылок сделки: `server/api/portal/links.post.ts`.
 *
 * ⚠ Заведён в третьем круге панели PR #93. Отзыв пишет две записи: нашу строку и стадию на портале.
 * Если вторая не дошла, повторным нажатием её не починить после обновления вкладки: по нашей строке
 * ссылка уже «отозвана», и кнопки у неё нет. Поэтому отражение дописывается здесь — там, где
 * расхождение видно всегда. Здесь держится, что дописывается ровно оно и что чужое решение клиента
 * (элемент, уведённый в свою стадию) не трогается.
 *
 * Роут импортируется напрямую, сессия, портал и база подделаны — приём в `survey-result-api.test.ts`.
 */

const SURVEY = { entityTypeId: 1040, id: 10, categoryId: 16 }

let items: Record<string, unknown>[]
let statuses: Map<number, string>
let writes: { method: string, params: Record<string, unknown> }[]
let attempts: number[]
let failWrites: boolean
/** Elements the portal refuses for good: a stage-required field, say. */
let refuseFor: Set<number>
/**
 * `PortalError` of the same module instance the route loads.
 *
 * ⚠ После `vi.resetModules()` роут получает свой экземпляр модуля, и отказ, брошенный классом
 * из верхнего импорта, для `instanceof` роута — чужой: код не прочитается, и отказ сочтётся
 * повторимым. Класс берётся тем же импортом, что и у роута.
 */
let Refusal: typeof PortalError

async function loadHandler() {
  writes = []
  attempts = []
  vi.doMock('../../server/api/portal/-session', () => ({
    openPortalSession: async () => ({
      portal: { id: 'портал', domain: 'shef.bitrix24.ru' },
      userId: 3,
      authId: 'фреймовый-токен',
      call: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'crm.item.list') return { result: { items } }
        attempts.push(params.id as number)
        if (refuseFor.has(params.id as number)) throw new Refusal('ACCESS_DENIED', 'поле обязательно на стадии')
        if (failWrites) throw new Error('портал не ответил за 10 с на crm.item.update')
        writes.push({ method, params })
        return { result: { item: { id: params.id } } }
      },
    }),
  }))
  vi.doMock('../../server/b24/frame-auth', () => ({ verifyDealAccess: async () => ({ ok: true }) }))
  vi.doMock('../../server/b24/provision', () => ({ readStoredRefs: async () => ({ survey: SURVEY }) }))
  vi.doMock('../../server/links/issue', () => ({ readLinkStatuses: async () => statuses }))
  vi.doMock('../../server/utils/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))
  vi.doMock('h3', async () => {
    const actual = await vi.importActual<typeof import('h3')>('h3')
    return { ...actual, readBody: async () => ({ dealId: 2 }) }
  })
  vi.resetModules()

  ;({ PortalError: Refusal } = await import('../../server/domain/portals/portal-error'))
  const { default: handler } = await import('../../server/api/portal/links.post')
  return (handler as unknown as (event: unknown) => Promise<{ ok: boolean, links: { itemId: number, state: string }[] }>)
}

const element = (id: number, stage: string, completedAt = '') => ({
  id,
  stageId: `DT1040_16:${stage}`,
  UF_CRM_10_TEMPLATE_CODE: 'brand',
  UF_CRM_10_EXPIRES_AT: '2099-01-01T00:00:00+03:00',
  UF_CRM_10_COMPLETED_AT: completedAt,
})

beforeEach(() => {
  failWrites = false
  refuseFor = new Set()
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

describe('список ссылок сделки', () => {
  it('ГЛАВНОЕ: погашенная у нас, а на портале «Отправлена» — отзыв дописывается при открытии вкладки', async () => {
    items = [element(54, 'NEW')]
    statuses = new Map([[54, 'revoked']])
    const handler = await loadHandler()

    const reply = await handler({})

    expect(reply.links.map(link => link.state)).toEqual(['revoked'])
    expect(writes.map(one => [one.params.id, one.params.fields])).toEqual([[54, { stageId: 'DT1040_16:FAIL' }]])
  })

  it('ГЛАВНОЕ: элемент, уведённый клиентом в свою стадию, и пройденный — не трогает', async () => {
    // Там уже решение клиента: тянуть его каждый раз обратно значило бы спорить с ним.
    items = [element(54, 'ARCHIVE'), element(55, 'NEW', '2026-09-20T03:00:00+03:00'), element(56, 'NEW')]
    statuses = new Map([[54, 'revoked'], [55, 'revoked'], [56, 'sent']])
    const handler = await loadHandler()

    await handler({})

    expect(writes).toEqual([])
  })

  it('ГЛАВНОЕ: за одно открытие дописывает не больше трёх — вкладка не ждёт портал без предела', async () => {
    // ⚠ Дописывание стоит на пути ответа, и каждое — вызов портала. Без предела вкладка сделки
    // с пачкой недописанных отзывов открывалась бы столько, сколько портал отвечает на все подряд.
    // Остальное допишут следующие открытия. Нашёл `/code-review` в панели PR #93.
    items = [54, 55, 56, 57, 58].map(id => element(id, 'NEW'))
    statuses = new Map(items.map(one => [one.id as number, 'revoked']))
    const handler = await loadHandler()

    const reply = await handler({})

    expect(reply.links.map(link => link.state)).toEqual(['revoked', 'revoked', 'revoked', 'revoked', 'revoked'])
    expect(writes.map(one => one.params.id)).toEqual([54, 55, 56])
  })

  it('ГЛАВНОЕ: отказ, который повтор не вылечит, место в пределе не занимает — следующее открытие дописывает старших', async () => {
    // ⚠ Предел берёт самые новые. Получи они отказ, который повтор не вылечит (поле, обязательное
    // по стадии «Отозвана»), они занимали бы все три места на каждом открытии — три заведомо
    // проваленные записи, а старшие не дописались бы никогда. Нашёл `/review` в закрывающем проходе.
    items = [58, 57, 56, 55, 54].map(id => element(id, 'NEW'))
    statuses = new Map(items.map(one => [one.id as number, 'revoked']))
    refuseFor = new Set([58, 57, 56])
    const handler = await loadHandler()

    await handler({})
    const firstTry = attempts.splice(0)
    await handler({})

    expect(firstTry).toEqual([58, 57, 56])
    expect(attempts).toEqual([55, 54])
    expect(writes.map(one => one.params.id)).toEqual([55, 54])
  })

  it('неудача дописывания список не роняет — починит следующее открытие', async () => {
    items = [element(54, 'NEW')]
    statuses = new Map([[54, 'revoked']])
    failWrites = true
    const handler = await loadHandler()

    expect((await handler({})).links.map(link => link.state)).toEqual(['revoked'])

    // Отказ повторимый (портал не ответил) — элемент не запоминается и дописывается следующим открытием.
    failWrites = false
    await handler({})

    expect(writes.map(one => one.params.id)).toEqual([54])
  })
})
