import { Buffer } from 'node:buffer'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TokenKeyError, openSecret, sealSecret, secretsEqual } from '../../server/utils/crypto'

/**
 * Токены портала — единственное, чья утечка из дампа базы означает доступ к чужой CRM.
 * Проверяем не «шифрование работает», а то, нарушение чего дорого стоит: что подменённая
 * запись не расшифруется, и что без ключа мы не сохраним токен открытым текстом.
 */

const KEY = Buffer.alloc(32, 7).toString('base64')
let saved: string | undefined

beforeEach(() => {
  saved = process.env.TOKEN_ENC_KEY
  process.env.TOKEN_ENC_KEY = KEY
})

afterEach(() => {
  if (saved === undefined) delete process.env.TOKEN_ENC_KEY
  else process.env.TOKEN_ENC_KEY = saved
})

describe('хранение токенов', () => {
  it('расшифровывает то, что зашифровало', () => {
    expect(openSecret(sealSecret('4s386p3q0tr8dy89xvmt96234v3dljg8'))).toBe('4s386p3q0tr8dy89xvmt96234v3dljg8')
  })

  it('каждый раз даёт разный шифротекст', () => {
    // Одинаковый шифротекст выдал бы, что два портала переустановились с тем же токеном.
    expect(sealSecret('один и тот же токен')).not.toBe(sealSecret('один и тот же токен'))
  })

  it('переживает кириллицу и пустую строку', () => {
    expect(openSecret(sealSecret('токен с текстом'))).toBe('токен с текстом')
    expect(openSecret(sealSecret(''))).toBe('')
  })

  it('ловит подмену шифротекста, а не расшифровывает его в мусор', () => {
    // Ради этого выбран GCM: расшифрованный «почти правильно» токен мы бы отправили
    // в портал и получили отказ, неотличимый от отозванного доступа.
    const [format, iv, tag, payload] = sealSecret('настоящий').split('.') as [string, string, string, string]
    const flipped = Buffer.from(payload, 'base64url')
    flipped[0] = flipped[0]! ^ 0xFF

    expect(() => openSecret([format, iv, tag, flipped.toString('base64url')].join('.'))).toThrow()
  })

  it('ловит подменённый тег', () => {
    const [format, iv, , payload] = sealSecret('настоящий').split('.') as [string, string, string, string]

    expect(() => openSecret([format, iv, Buffer.alloc(16).toString('base64url'), payload].join('.'))).toThrow()
  })

  it('не принимает чужой формат и обрезанную строку', () => {
    expect(() => openSecret('v2.a.b.c')).toThrow(/формата/)
    expect(() => openSecret('просто строка')).toThrow(/четыре части/)
  })

  it('не расшифровывает чужим ключом', () => {
    const sealed = sealSecret('секрет')
    process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString('base64')

    expect(() => openSecret(sealed)).toThrow()
  })

  describe('ключ', () => {
    it('без ключа отказывается шифровать, а не пишет открытым текстом', () => {
      delete process.env.TOKEN_ENC_KEY

      expect(() => sealSecret('токен')).toThrow(TokenKeyError)
    })

    it('отвергает ключ неправильной длины', () => {
      process.env.TOKEN_ENC_KEY = Buffer.alloc(16, 1).toString('base64')

      expect(() => sealSecret('токен')).toThrow(TokenKeyError)
    })

    it('принимает и hex, и base64', () => {
      process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 3).toString('hex')
      const sealed = sealSecret('токен')

      expect(openSecret(sealed)).toBe('токен')
    })
  })
})

describe('сравнение секретов', () => {
  it('совпадающие строки равны, разные — нет', () => {
    expect(secretsEqual('51856fefc120afa4b628cc82d3935cce', '51856fefc120afa4b628cc82d3935cce')).toBe(true)
    expect(secretsEqual('51856fefc120afa4b628cc82d3935cce', '51856fefc120afa4b628cc82d3935ccd')).toBe(false)
  })

  it('не падает на строках разной длины', () => {
    // `timingSafeEqual` на разной длине бросает, и незакрытый случай уронил бы обработчик.
    expect(secretsEqual('короткая', 'подлиннее строка')).toBe(false)
    expect(secretsEqual('', 'что-то')).toBe(false)
  })
})
