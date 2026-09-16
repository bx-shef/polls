import { describe, expect, it } from 'vitest'
import { hashToken, isTokenShaped, mintToken } from '../../server/domain/links/token'

/**
 * Токен — единственный ключ доступа к чужой анкете. В разобранном решении заказчика это был
 * `md5(ID элемента + '_' + ID сделки)`: зная пару идентификаторов, чужую анкету открывали
 * перебором. Тесты здесь держат ровно то, чем новая схема от той отличается.
 */

describe('выпуск токена', () => {
  it('даёт не меньше 128 бит случайности', () => {
    // Инвариант проекта. 43 символа base64url — это 32 байта, вдвое больше минимума.
    const token = mintToken()

    expect(token).toHaveLength(43)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  })

  it('не повторяется', () => {
    const minted = new Set(Array.from({ length: 500 }, () => mintToken()))

    expect(minted.size).toBe(500)
  })

  it('не содержит символов, ломающих ссылку в письме', () => {
    // base64url без набивки: ни `=`, ни `+`, ни `/`. Иначе часть почтовых клиентов
    // обрежет ссылку на автоопределении границы, и человек получит нерабочий адрес.
    for (let i = 0; i < 200; i++) {
      expect(mintToken()).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})

describe('хеш токена', () => {
  it('устойчив: один токен — один хеш', () => {
    const token = mintToken()

    expect(hashToken(token)).toBe(hashToken(token))
  })

  it('не совпадает у разных токенов', () => {
    expect(hashToken(mintToken())).not.toBe(hashToken(mintToken()))
  })

  it('не содержит самого токена', () => {
    // Гвард против «оптимизации» вида «сохраним и токен тоже, так удобнее искать».
    const token = mintToken()

    expect(hashToken(token)).not.toContain(token)
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('проверка формы токена', () => {
  it('узнаёт настоящий', () => {
    expect(isTokenShaped(mintToken())).toBe(true)
  })

  it.each([
    ['', 'пусто'],
    ['короткий', 'слишком короткий'],
    ['a'.repeat(44), 'слишком длинный'],
    ['../../etc/passwd', 'попытка выйти из пути'],
    ['aaaa+aaaa/aaaa=', 'обычный base64, а не base64url'],
    [`${'a'.repeat(42)}!`, 'посторонний символ'],
  ])('отвергает негодное (%#: %s)', (candidate) => {
    expect(isTokenShaped(candidate)).toBe(false)
  })
})
