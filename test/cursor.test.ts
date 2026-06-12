import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../src/store/cursor'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

describe('cursor encode/decode', () => {
  it('round-trip сохраняет ключ', () => {
    const k = { submittedAt: '2026-04-01T10:00:00.000Z', id: '42' }
    expect(decodeCursor(encodeCursor(k))).toEqual(k)
  })

  it('битый base64/JSON → понятная ошибка (не SyntaxError)', () => {
    expect(() => decodeCursor(b64('{ это не json'))).toThrow(/Невалидный курсор/)
  })

  it('валидный JSON, но неверная структура → ошибка', () => {
    expect(() => decodeCursor(b64(JSON.stringify({ foo: 1 })))).toThrow(/Невалидный курсор/)
    expect(() => decodeCursor(b64(JSON.stringify({ submittedAt: 'не-дата', id: '1' })))).toThrow(/Невалидный курсор/)
  })
})
