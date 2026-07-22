import { describe, expect, it } from 'vitest'
import { parseUninstallEvent, decideUninstall, type UninstallEvent } from '../src/bitrix24/uninstall'

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'ONAPPUNINSTALL',
  auth: { member_id: 'm-1', application_token: 'app-tok-1' },
  ts: 1700,
  ...over
})

describe('parseUninstallEvent (мягкий парс недоверенного POST)', () => {
  it('валидное событие → распарсено', () => {
    const e = parseUninstallEvent(raw())
    expect(e).toMatchObject({ event: 'ONAPPUNINSTALL', auth: { member_id: 'm-1', application_token: 'app-tok-1' }, ts: 1700 })
  })

  it('ts-строка коэрсится в число; без ts → undefined', () => {
    expect(parseUninstallEvent(raw({ ts: '1700' }))?.ts).toBe(1700)
    const { ts: _drop, ...noTs } = raw()
    expect(parseUninstallEvent(noTs)?.ts).toBeUndefined()
  })

  it('не тот event → null', () => {
    expect(parseUninstallEvent(raw({ event: 'ONAPPINSTALL' }))).toBeNull()
  })

  it('нет auth / application_token / member_id → null', () => {
    expect(parseUninstallEvent(raw({ auth: undefined }))).toBeNull()
    expect(parseUninstallEvent(raw({ auth: { member_id: 'm-1' } }))).toBeNull()
    expect(parseUninstallEvent(raw({ auth: { application_token: 'x' } }))).toBeNull()
  })

  it('мусор → null (не бросает)', () => {
    expect(parseUninstallEvent(null)).toBeNull()
    expect(parseUninstallEvent('строка')).toBeNull()
    expect(parseUninstallEvent({})).toBeNull()
  })
})

describe('decideUninstall (вердикт, constant-time сверка токена)', () => {
  const event = parseUninstallEvent(raw()) as UninstallEvent

  it('нет сохранённого токена → unknown_portal (ничего не удаляем)', () => {
    expect(decideUninstall(event, undefined, 9999)).toEqual({ ok: false, reason: 'unknown_portal' })
    expect(decideUninstall(event, '', 9999)).toEqual({ ok: false, reason: 'unknown_portal' })
  })

  it('токен не совпал → bad_token (подделка)', () => {
    expect(decideUninstall(event, 'другой-токен', 9999)).toEqual({ ok: false, reason: 'bad_token' })
  })

  it('токен совпал → ok, deletedTs из события', () => {
    expect(decideUninstall(event, 'app-tok-1', 9999)).toEqual({ ok: true, memberId: 'm-1', deletedTs: 1700 })
  })

  it('токен совпал, событие без ts → deletedTs = nowSec', () => {
    const noTs = parseUninstallEvent({ event: 'ONAPPUNINSTALL', auth: { member_id: 'm-2', application_token: 'app-tok-1' } }) as UninstallEvent
    expect(decideUninstall(noTs, 'app-tok-1', 9999)).toEqual({ ok: true, memberId: 'm-2', deletedTs: 9999 })
  })
})
