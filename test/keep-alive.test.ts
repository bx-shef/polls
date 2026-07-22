import { describe, expect, it, vi } from 'vitest'
import { keepAliveIntervalMs, runKeepAlive, type KeepAliveDeps } from '../src/bitrix24/keep-alive'
import { nullLogger } from '../src/obs/logger'

const HOUR = 3_600_000

describe('keepAliveIntervalMs (клэмп + защита от overflow setInterval)', () => {
  it('дефолт 24ч при пустом/невалидном env', () => {
    expect(keepAliveIntervalMs(undefined)).toBe(24 * HOUR)
    expect(keepAliveIntervalMs('')).toBe(24 * HOUR)
    expect(keepAliveIntervalMs('nan')).toBe(24 * HOUR)
    expect(keepAliveIntervalMs('0')).toBe(24 * HOUR) // непозитивное → дефолт
    expect(keepAliveIntervalMs('-5')).toBe(24 * HOUR)
  })

  it('валидное значение проходит', () => {
    expect(keepAliveIntervalMs('6')).toBe(6 * HOUR)
    expect(keepAliveIntervalMs('48')).toBe(48 * HOUR)
  })

  it('клэмп снизу [1ч]', () => {
    expect(keepAliveIntervalMs('0.5')).toBe(1 * HOUR)
  })

  it('клэмп сверху [168ч] — защита от overflow (>2³¹ мс схлопнулся бы в 1мс)', () => {
    expect(keepAliveIntervalMs('200')).toBe(168 * HOUR)
    expect(keepAliveIntervalMs('100000')).toBe(168 * HOUR)
  })

  it('кастомный дефолт', () => {
    expect(keepAliveIntervalMs(undefined, 12)).toBe(12 * HOUR)
  })

  it('точные границы проходят без клэмпа', () => {
    expect(keepAliveIntervalMs('1')).toBe(1 * HOUR)
    expect(keepAliveIntervalMs('168')).toBe(168 * HOUR)
  })

  it('Infinity → дефолт; невалид + кастомный дефолт', () => {
    expect(keepAliveIntervalMs('Infinity')).toBe(24 * HOUR)
    expect(keepAliveIntervalMs('nan', 12)).toBe(12 * HOUR)
  })
})

describe('runKeepAlive (изоляция ошибок пер-портал)', () => {
  it('пустой список — ноль работы, но сводка run всё равно пишется (видимость таймера)', async () => {
    const logger = { ...nullLogger, info: vi.fn(), warn: vi.fn() }
    const deps: KeepAliveDeps = {
      listNearExpiry: () => Promise.resolve([]),
      refreshOne: () => Promise.reject(new Error('не должно вызываться')),
      logger
    }
    expect(await runKeepAlive(deps)).toEqual({ total: 0, refreshed: 0, failed: 0 })
    expect(logger.info).toHaveBeenCalledWith('keepalive_run', { total: 0, refreshed: 0, failed: 0 })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('все успешно — refreshed == total', async () => {
    const refreshOne = vi.fn(() => Promise.resolve())
    const res = await runKeepAlive({
      listNearExpiry: () => Promise.resolve(['m-1', 'm-2', 'm-3']),
      refreshOne
    })
    expect(res).toEqual({ total: 3, refreshed: 3, failed: 0 })
    expect(refreshOne).toHaveBeenCalledTimes(3)
  })

  it('один портал падает — остальные рефрешатся (изоляция); детали в лог-полях (не в msg)', async () => {
    const logger = { ...nullLogger, info: vi.fn(), warn: vi.fn() }
    const refreshOne = vi.fn((m: string) => (m === 'm-bad' ? Promise.reject(new Error('invalid_grant')) : Promise.resolve()))
    const res = await runKeepAlive({
      listNearExpiry: () => Promise.resolve(['m-1', 'm-bad', 'm-3']),
      refreshOne,
      logger
    })
    expect(res).toEqual({ total: 3, refreshed: 2, failed: 1 })
    expect(refreshOne).toHaveBeenCalledTimes(3) // упавший не прервал цикл
    // member_id/причина — в НЕ-`msg` полях (иначе зарезервированный msg их перетёр бы).
    expect(logger.warn).toHaveBeenCalledWith('keepalive_refresh_fail', { memberId: 'm-bad', reason: 'invalid_grant' })
    expect(logger.info).toHaveBeenCalledWith('keepalive_run', { total: 3, refreshed: 2, failed: 1 })
  })

  it('все падают — refreshed 0, сводка всё равно пишется', async () => {
    const logger = { ...nullLogger, info: vi.fn(), warn: vi.fn() }
    const res = await runKeepAlive({
      listNearExpiry: () => Promise.resolve(['m-1', 'm-2']),
      refreshOne: () => Promise.reject(new Error('dead')),
      logger
    })
    expect(res).toEqual({ total: 2, refreshed: 0, failed: 2 })
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith('keepalive_run', { total: 2, refreshed: 0, failed: 2 })
  })

  it('refreshOne бросает не-Error значение — деградирует без throw (errInfo терпит)', async () => {
    const res = await runKeepAlive({
      listNearExpiry: () => Promise.resolve(['m-x']),
      refreshOne: () => Promise.reject('boom') // не Error
    })
    expect(res).toEqual({ total: 1, refreshed: 0, failed: 1 })
  })
})
