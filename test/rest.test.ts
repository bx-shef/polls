import { describe, expect, it, vi } from 'vitest'
import { Bitrix24Rest, Bitrix24RestError, dealGet } from '../src/bitrix24/rest'
import { type HttpFetch, type HttpResponse } from '../src/bitrix24/oauth'

const CTX = { domain: 'acme.bitrix24.ru', accessToken: 'AT-xyz' }

function resp(status: number, json: unknown, jsonThrows = false): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jsonThrows ? () => Promise.reject(new Error('not json')) : () => Promise.resolve(json)
  }
}

describe('Bitrix24Rest.call (#17)', () => {
  it('успех → result; auth в ТЕЛЕ POST (не в URL), верный путь метода', async () => {
    const fetch = vi.fn<HttpFetch>(async () => resp(200, { result: { ID: '5', STAGE_ID: 'C1:WON' } }))
    const rest = new Bitrix24Rest({ fetch })
    const r = await rest.call('crm.deal.get', { id: 5 }, CTX)
    expect(r).toEqual({ ID: '5', STAGE_ID: 'C1:WON' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://acme.bitrix24.ru/rest/crm.deal.get')
    expect(url).not.toContain('AT-xyz') // токена нет в URL
    expect(JSON.parse(init!.body as string)).toEqual({ id: 5, auth: 'AT-xyz' })
  })

  it('ответ с error → Bitrix24RestError (с кодом)', async () => {
    const rest = new Bitrix24Rest({ fetch: async () => resp(400, { error: 'NOT_FOUND', error_description: 'Not found' }) })
    await expect(rest.call('crm.deal.get', { id: 9 }, CTX)).rejects.toMatchObject({
      name: 'Bitrix24RestError',
      code: 'NOT_FOUND'
    })
  })

  it('ok без result / не-JSON / сеть → Bitrix24RestError', async () => {
    const r1 = new Bitrix24Rest({ fetch: async () => resp(200, { time: {} }) })
    await expect(r1.call('app.info', {}, CTX)).rejects.toBeInstanceOf(Bitrix24RestError)
    const r2 = new Bitrix24Rest({ fetch: async () => resp(502, null, true) })
    await expect(r2.call('app.info', {}, CTX)).rejects.toBeInstanceOf(Bitrix24RestError)
    const r3 = new Bitrix24Rest({
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    await expect(r3.call('app.info', {}, CTX)).rejects.toBeInstanceOf(Bitrix24RestError)
  })

  it('SSRF: недоверенный домен → отказ ДО fetch', async () => {
    const fetch = vi.fn<HttpFetch>(async () => resp(200, { result: 1 }))
    const rest = new Bitrix24Rest({ fetch })
    await expect(rest.call('app.info', {}, { domain: 'evil.com', accessToken: 'x' })).rejects.toBeInstanceOf(
      Bitrix24RestError
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('инъекция в имя метода → отказ ДО fetch', async () => {
    const fetch = vi.fn<HttpFetch>(async () => resp(200, { result: 1 }))
    const rest = new Bitrix24Rest({ fetch })
    await expect(rest.call('../../evil', {}, CTX)).rejects.toBeInstanceOf(Bitrix24RestError)
    await expect(rest.call('crm/deal', {}, CTX)).rejects.toBeInstanceOf(Bitrix24RestError)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('dealGet (#17)', () => {
  it('зовёт crm.deal.get с id и отдаёт поля', async () => {
    const fetch = vi.fn<HttpFetch>(async () => resp(200, { result: { ID: '759', STAGE_ID: 'NEW' } }))
    const deal = await dealGet(new Bitrix24Rest({ fetch }), CTX, 759)
    expect(deal).toMatchObject({ ID: '759', STAGE_ID: 'NEW' })
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ id: 759, auth: 'AT-xyz' })
  })
})
