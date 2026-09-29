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
  warned: string[]
}

let probe: Probe
let item: Record<string, unknown>
let linkStatus: string | null
let revokedRows: number
/** Дела выпуска, которые находит поиск по ключу; пусто — ссылка выпущена до issue #84, п. 14. */
let activities: Record<string, unknown>[]
/** Как портал отвечает на закрытие дела. */
let closeActivity: () => unknown
/** Как портал отвечает на запись стадии. */
let writeStage: () => unknown

async function loadHandler() {
  probe = { portalCalls: [], revoked: [], warned: [] }

  vi.doMock('../../server/api/portal/-session', () => ({
    openPortalSession: async () => ({
      portal: { id: 'портал', domain: 'shef.bitrix24.ru' },
      userId: 3,
      authId: 'фреймовый-токен',
      call: async (method: string, params: Record<string, unknown> = {}) => {
        probe.portalCalls.push({ method, params })
        if (method === 'crm.item.list') return { result: { items: [item] } }
        if (method === 'crm.activity.list') return { result: activities }
        if (method === 'crm.activity.update') return closeActivity()
        if (method === 'crm.item.update') return writeStage()
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
  vi.doMock('../../server/utils/logger', () => ({
    logger: { info: () => {}, warn: (_fields: unknown, message: string) => void probe.warned.push(message), error: () => {} },
  }))
  vi.doMock('h3', async () => {
    const actual = await vi.importActual<typeof import('h3')>('h3')
    return { ...actual, readBody: async () => ({ dealId: DEAL, itemId: ITEM }) }
  })
  vi.resetModules()

  const { default: handler } = await import('../../server/api/portal/revoke.post')
  return (handler as unknown as (event: unknown) => Promise<Record<string, unknown>>)
}

const stageWrites = () => probe.portalCalls.filter(one => one.method === 'crm.item.update')
const activityCloses = () => probe.portalCalls.filter(one => one.method === 'crm.activity.update')

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
  activities = []
  closeActivity = () => ({ result: true })
  writeStage = () => ({ result: { item: { id: ITEM } } })
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

  it('уже отозванную базой и на портале второй раз не гасит', async () => {
    linkStatus = 'revoked'
    item = { ...item, stageId: 'DT1040_16:FAIL' }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-revocable' })
    expect(probe.revoked).toEqual([])
    expect(stageWrites()).toEqual([])
  })

  it('ГЛАВНОЕ: наша строка погашена, а «Отозвана» до портала не дошла — повторное нажатие дописывает', async () => {
    // ⚠ Прошлый отзыв упал между двумя записями: ссылка уже не открывается, а элемент «Отправлен».
    // Без этой ветки повтор отвечал «нечего гасить», и роботы клиента на «Отозвана» не сработали бы
    // никогда. Нашли `/review` и `/code-review` во втором круге панели PR #93.
    linkStatus = 'revoked'
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true })
    expect(probe.revoked).toEqual([])
    expect(stageWrites().map(one => one.params.fields)).toEqual([{ stageId: 'DT1040_16:FAIL' }])
  })

  it('элемент без нашей строки — страницы нет, гасить нечего', async () => {
    linkStatus = null
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-revocable' })
    expect(probe.revoked).toEqual([])
    expect(stageWrites()).toEqual([])
  })
})

describe('дело выпуска при отзыве (issue #84, п. 14)', () => {
  const OPEN = { ID: '308', COMPLETED: 'N', OWNER_TYPE_ID: '1040', OWNER_ID: String(ITEM), SUBJECT: 'Отправить опрос клиенту: Бренд' }

  it('ГЛАВНОЕ: открытое дело закрывается с «Ссылка отозвана» — после стадии, одним вызовом', async () => {
    activities = [OPEN]
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true })

    const closes = activityCloses()
    expect(closes).toHaveLength(1)
    expect(closes[0]!.params).toMatchObject({ id: 308, fields: { SUBJECT: 'Ссылка отозвана: Бренд', COMPLETED: 'Y' } })
    const methods = probe.portalCalls.map(one => one.method)
    expect(methods.indexOf('crm.item.update')).toBeLessThan(methods.indexOf('crm.activity.update'))
  })

  it('ищет дело по ключу ВЫПУСКА этого элемента', async () => {
    activities = [OPEN]
    const handler = await loadHandler()

    await handler({})

    const find = probe.portalCalls.find(one => one.method === 'crm.activity.list')!
    expect(find.params.filter).toEqual({ ORIGINATOR_ID: 'SHEF_SURVEY', ORIGIN_ID: `survey-link-${SURVEY.entityTypeId}-${ITEM}` })
  })

  it('дела выпуска нет — ссылка выпущена до п. 14: закрывать нечего, отзыв в порядке', async () => {
    // Нашёл тестировщик в панели PR #102: этот случай исполнялся только мимоходом, в старых тестах.
    activities = []
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true })
    expect(activityCloses()).toEqual([])
    // И без сбоя внутри: «дела нет» — штатный случай, а не отказ, пойманный перехватом.
    expect(probe.warned).toEqual([])
  })

  it('ГЛАВНОЕ: стадия не легла — дело выпуска всё равно закрыто, а отказ стадии уходит наверх', async () => {
    // ⚠ Прежде дело закрывалось только после стадии: отказ стадии оставлял его открытым с мёртвым
    // адресом, а дописывание стадии дела не трогало (`/code-review`, PR #102).
    activities = [OPEN]
    writeStage = () => {
      throw new Error('портал не ответил за 20 с на crm.item.update')
    }
    const handler = await loadHandler()

    await expect(handler({})).rejects.toThrow()
    expect(activityCloses()).toHaveLength(1)
  })

  it('закрытое менеджером дело не трогает', async () => {
    activities = [{ ...OPEN, COMPLETED: 'Y' }]
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true })
    expect(activityCloses()).toEqual([])
  })

  it('ГЛАВНОЕ: отказ закрытия дела отзыв не отменяет — ссылку гасит наша строка', async () => {
    activities = [OPEN]
    closeActivity = () => {
      throw new Error('ACCESS_DENIED')
    }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true })
    expect(probe.revoked).toEqual([ITEM])
  })

  it('повторное нажатие, дописывающее стадию, закрывает и дело', async () => {
    linkStatus = 'revoked'
    activities = [OPEN]
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true })
    expect(activityCloses()).toHaveLength(1)
  })

  it('база не погасила строку — дело не трогаем: ответ мог уже прийти', async () => {
    revokedRows = 0
    activities = [OPEN]
    const handler = await loadHandler()

    await handler({})

    expect(probe.portalCalls.some(one => one.method.startsWith('crm.activity.'))).toBe(false)
  })
})
