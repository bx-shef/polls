import { describe, expect, it } from 'vitest'
import { parseBracketForm } from '../src/bitrix24/bracket-form'

describe('parseBracketForm (bracket-нотация B24 → вложенный объект)', () => {
  it('собирает auth[..]/data[..] в вложенные объекты, простые ключи — как есть', () => {
    expect(
      parseBracketForm({
        event: 'ONAPPUNINSTALL',
        'auth[member_id]': 'm-1',
        'auth[application_token]': 'tok',
        'data[CLEAN]': '1',
        ts: '1700'
      })
    ).toEqual({
      event: 'ONAPPUNINSTALL',
      auth: { member_id: 'm-1', application_token: 'tok' },
      data: { CLEAN: '1' },
      ts: '1700'
    })
  })

  it('несколько потомков одного родителя', () => {
    expect(parseBracketForm({ 'a[x]': '1', 'a[y]': '2' })).toEqual({ a: { x: '1', y: '2' } })
  })

  it('идемпотентно на уже вложенном входе (JSON-тело)', () => {
    const nested = { event: 'X', auth: { member_id: 'm' } }
    expect(parseBracketForm(nested)).toEqual(nested)
  })

  it('гард prototype-pollution: опасные ключи отбрасываются, прототип не тронут', () => {
    const out = parseBracketForm({
      '__proto__[polluted]': 'yes',
      'a[__proto__]': 'x',
      'constructor[bad]': 'y',
      good: 'ok'
    })
    expect(out).toEqual({ good: 'ok' })
    // Ключевая проверка: глобальный Object не отравлен.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((out as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('конфликт flat+bracket одного имени: bracket перезаписывает не-объект', () => {
    // 'a'='str' (не-объект), затем 'a[x]' — bucket создаётся заново, строка вытесняется.
    expect(parseBracketForm({ a: 'str', 'a[x]': '1' })).toEqual({ a: { x: '1' } })
  })

  it('пустой вход → пустой объект', () => {
    expect(parseBracketForm({})).toEqual({})
  })
})
