import { describe, expect, it, vi } from 'vitest'
import { callMethod, dealGet, dealProductRows, entityGet, frameToB24Params, stageHistoryList, stageHistoryParams, Bitrix24CallError, type PortalClient, type CallResult } from '../src/bitrix24/client'

/** Мок результата AjaxResult. */
function ok(result: unknown): CallResult {
  return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
}
function fail(...msgs: string[]): CallResult {
  return { isSuccess: false, getData: () => null, getErrorMessages: () => msgs }
}
/** Мок PortalClient с заданным результатом (вызов через actions.v2.call.make, #95). */
function client(res: CallResult): PortalClient & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const make = vi.fn(async (opts: { method: string; params?: object }) => (calls.push([opts.method, opts.params]), res))
  return { calls, actions: { v2: { call: { make } } } }
}

describe('callMethod — обёртка над b24jssdk actions.v2 (#17/#95)', () => {
  it('успех → result; метод и params проброшены', async () => {
    const c = client(ok({ ID: '5', STAGE_ID: 'C1:WON' }))
    const r = await callMethod(c, 'crm.deal.get', { id: 5 })
    expect(r).toEqual({ ID: '5', STAGE_ID: 'C1:WON' })
    expect(c.calls[0]).toEqual(['crm.deal.get', { id: 5 }])
  })

  it('неуспех → Bitrix24CallError с сообщениями SDK', async () => {
    const c = client(fail('Not found', 'bad id'))
    await expect(callMethod(c, 'crm.deal.get', { id: 9 })).rejects.toMatchObject({
      name: 'Bitrix24CallError',
      message: 'Not found; bad id'
    })
  })

  it('пустой result → Bitrix24CallError', async () => {
    const c = client(ok(undefined))
    await expect(callMethod(c, 'app.info')).rejects.toBeInstanceOf(Bitrix24CallError)
  })

  it('params по умолчанию — пустой объект', async () => {
    const c = client(ok({ ok: true }))
    await callMethod(c, 'app.info')
    expect(c.calls[0]).toEqual(['app.info', {}])
  })
})

describe('dealGet (#17)', () => {
  it('зовёт crm.deal.get с id и отдаёт поля сделки', async () => {
    const c = client(ok({ ID: '759', STAGE_ID: 'NEW', COMPANY_ID: '42' }))
    const deal = await dealGet(c, 759)
    expect(deal).toMatchObject({ ID: '759', STAGE_ID: 'NEW' })
    expect(c.calls[0]).toEqual(['crm.deal.get', { id: 759 }])
  })
})

describe('dealProductRows (#17 — товарные позиции)', () => {
  it('зовёт crm.deal.productrows.get с id и отдаёт строки', async () => {
    const c = client(ok([{ PRODUCT_ID: '13', PRODUCT_NAME: 'X' }]))
    const rows = await dealProductRows(c, 21)
    expect(rows).toEqual([{ PRODUCT_ID: '13', PRODUCT_NAME: 'X' }])
    expect(c.calls[0]).toEqual(['crm.deal.productrows.get', { id: 21 }])
  })
})

describe('stageHistoryList — история движения по стадиям (#17)', () => {
  it('зовёт crm.stagehistory.list с типом/фильтром/сортировкой и разворачивает items', async () => {
    const c = client(ok({ items: [{ ID: 2, STAGE_ID: 'C1:WON' }, { ID: 1, STAGE_ID: 'NEW' }] }))
    const rows = await stageHistoryList(c, 2, 759)
    expect(rows).toEqual([{ ID: 2, STAGE_ID: 'C1:WON' }, { ID: 1, STAGE_ID: 'NEW' }])
    expect(c.calls[0]).toEqual([
      'crm.stagehistory.list',
      {
        entityTypeId: 2,
        order: { ID: 'DESC' },
        filter: { OWNER_ID: 759 },
        select: ['ID', 'CREATED_TIME', 'STAGE_ID']
      }
    ])
  })

  it('пустой/неожиданный ответ → пустой массив (не падаем)', async () => {
    expect(await stageHistoryList(client(ok({})), 2, 1)).toEqual([])
    expect(await stageHistoryList(client(ok({ items: 'не-массив' })), 2, 1)).toEqual([])
  })

  it('страница отдаётся целиком, БЕЗ среза (срез до сортировки мог бы оставить самые старые записи)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ID: i }))
    expect(await stageHistoryList(client(ok({ items: many })), 2, 1)).toHaveLength(50)
  })

  it('null-результат портала не роняет разбор', async () => {
    expect(await stageHistoryList(client(ok(null)), 2, 1)).toEqual([])
  })

  it('параметры вынесены отдельно и это ТЕ ЖЕ параметры, что шлёт боевой вызов', async () => {
    // Живой smoke (`scripts/b24-smoke.ts`, секция B2) обязан бить тем же запросом, иначе он «зелёный»
    // на форме, которой в проде нет. Гвоздь: билдер один и совпадает с фактическим вызовом.
    const c = client(ok({ items: [] }))
    await stageHistoryList(c, 2, 759)
    expect(c.calls[0]?.[1]).toEqual(stageHistoryParams(2, 759))
  })
})

describe('entityGet (#34 binding-слой)', () => {
  it('deal/lead/contact/company → crm.<entity>.get({id})', async () => {
    for (const [entity, method] of [
      ['deal', 'crm.deal.get'],
      ['lead', 'crm.lead.get'],
      ['contact', 'crm.contact.get'],
      ['company', 'crm.company.get']
    ] as const) {
      const c = client(ok({ ID: '1' }))
      const r = await entityGet(c, entity, 1)
      expect(c.calls[0]).toEqual([method, { id: 1 }])
      expect(r).toMatchObject({ ID: '1' })
    }
  })
  it('spa → crm.item.get({entityTypeId,id}) с разворотом { item }', async () => {
    const c = client(ok({ item: { id: 7, stageId: 'DT1056:WON' } }))
    const r = await entityGet(c, 'spa', 7, 1056)
    expect(c.calls[0]).toEqual(['crm.item.get', { entityTypeId: 1056, id: 7 }])
    expect(r).toMatchObject({ id: 7, stageId: 'DT1056:WON' })
  })
  it('spa без spaEntityTypeId → бросает', async () => {
    await expect(entityGet(client(ok({})), 'spa', 7)).rejects.toBeInstanceOf(Bitrix24CallError)
  })
  it('spa: ответ без item (не найдено) → бросает, не возвращает null', async () => {
    await expect(entityGet(client(ok({ item: null })), 'spa', 7, 1056)).rejects.toBeInstanceOf(Bitrix24CallError)
    await expect(entityGet(client(ok({})), 'spa', 7, 1056)).rejects.toBeInstanceOf(Bitrix24CallError)
  })
})

describe('frameToB24Params (#17)', () => {
  it('минимальный auth → B24OAuthParams с дефолтами', () => {
    const p = frameToB24Params({ domain: 'acme.bitrix24.ru', accessToken: 'AT', memberId: 'm-1' })
    expect(p).toMatchObject({
      memberId: 'm-1',
      accessToken: 'AT',
      domain: 'acme.bitrix24.ru',
      clientEndpoint: 'https://acme.bitrix24.ru/rest/',
      serverEndpoint: 'https://oauth.bitrix.info/rest/',
      status: 'L'
    })
    expect(p.expiresIn).toBe(3600)
  })
})

describe('ретрай SDK на уровне одного REST-вызова запрещён', () => {
  it('createPortalClient дожидается настройки, а не ставит её «на потом»', async () => {
    // `setRestrictionManagerParams` асинхронна: без `await` настройка могла бы не примениться до
    // первого вызова, и ретрай остался бы включённым — тихо и незаметно.
    const { NO_RETRY_PARAMS } = await import('../src/bitrix24/client')
    expect(NO_RETRY_PARAMS).toEqual({ maxRetries: 1, retryOnNetworkError: false })

    const src = await sourceOf('../src/bitrix24/client.ts')
    expect(src).toMatch(/await client\.setRestrictionManagerParams\(/)
  })

  it('ни один роут не строит клиент портала в обход createPortalClient', async () => {
    // Голый `new B24OAuth(...)` вернул бы дефолтный ретрай: повтор `*.add` после клиентского таймаута
    // создаёт ВТОРУЮ сущность в портале, а уникальности по originId/xmlId Bitrix не гарантирует.
    const { readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = fileURLToPath(new URL('..', import.meta.url))
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
      )
    for (const f of [...walk(join(root, 'server')), join(root, 'src/bitrix24/portal.ts')]) {
      const code = await sourceOf(f)
      expect(code.includes('new B24OAuth('), `${f}: клиент портала мимо createPortalClient`).toBe(false)
    }
  })
})

/** Исходник без комментариев: гард не должен удовлетворяться упоминанием в прозе. */
async function sourceOf(pathOrRel: string): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const abs = pathOrRel.startsWith('/') ? pathOrRel : fileURLToPath(new URL(pathOrRel, import.meta.url))
  return readFileSync(abs, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
