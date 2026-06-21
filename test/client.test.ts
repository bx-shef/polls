import { describe, expect, it, vi } from 'vitest'
import { callMethod, dealGet, taskGet, frameToB24Params, Bitrix24CallError, type PortalClient, type CallResult } from '../src/bitrix24/client'

/** Мок результата AjaxResult. */
function ok(result: unknown): CallResult {
  return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
}
function fail(...msgs: string[]): CallResult {
  return { isSuccess: false, getData: () => null, getErrorMessages: () => msgs }
}
/** Мок PortalClient с заданным результатом. */
function client(res: CallResult): PortalClient & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return { calls, callMethod: vi.fn(async (...a: unknown[]) => (calls.push(a), res)) }
}

describe('callMethod — обёртка над b24jssdk (#17)', () => {
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

describe('taskGet (задача)', () => {
  it('зовёт tasks.task.get с taskId+select и разворачивает { task }', async () => {
    const c = client(ok({ task: { id: 812, title: 'T', responsibleId: 5, ufCrmTask: ['D_6529'] } }))
    const task = await taskGet(c, 812)
    expect(task).toMatchObject({ id: 812, responsibleId: 5, ufCrmTask: ['D_6529'] })
    expect((c.calls[0] as [string, { taskId: number }])[0]).toBe('tasks.task.get')
    expect((c.calls[0] as [string, { taskId: number }])[1].taskId).toBe(812)
  })
  it('разворачивает { item } (REST v3)', async () => {
    const c = client(ok({ item: { id: 9, crmItemIds: ['C_45'] } }))
    expect(await taskGet(c, 9)).toMatchObject({ id: 9, crmItemIds: ['C_45'] })
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
