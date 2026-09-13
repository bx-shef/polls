import { Buffer } from 'node:buffer'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TokenKeyError, decryptSecret, encryptSecret } from '../../server/utils/crypto'

/**
 * Токены портала — единственное, чья утечка из дампа базы означает доступ к чужой CRM.
 * Проверяем не «шифрование работает», а то, нарушение чего дорого стоит: что подменённая
 * запись не расшифруется, и что без ключа мы не сохраним токен открытым текстом.
 */

const KEY = Buffer.alloc(32, 7).toString('base64')
let saved: string | undefined

beforeEach(() => {
  saved = process.env.B24_TOKEN_ENC_KEY
  process.env.B24_TOKEN_ENC_KEY = KEY
})

afterEach(() => {
  if (saved === undefined) delete process.env.B24_TOKEN_ENC_KEY
  else process.env.B24_TOKEN_ENC_KEY = saved
})

describe('хранение токенов', () => {
  it('расшифровывает то, что зашифровало', () => {
    expect(decryptSecret(encryptSecret('4s386p3q0tr8dy89xvmt96234v3dljg8'))).toBe('4s386p3q0tr8dy89xvmt96234v3dljg8')
  })

  it('каждый раз даёт разный шифротекст', () => {
    // Одинаковый шифротекст выдал бы, что два портала переустановились с тем же токеном.
    expect(encryptSecret('один и тот же токен')).not.toBe(encryptSecret('один и тот же токен'))
  })

  it('переживает кириллицу и пустую строку', () => {
    expect(decryptSecret(encryptSecret('токен с текстом'))).toBe('токен с текстом')
    expect(decryptSecret(encryptSecret(''))).toBe('')
  })

  it('ловит подмену шифротекста, а не расшифровывает его в мусор', () => {
    // Ради этого выбран GCM: расшифрованный «почти правильно» токен мы бы отправили
    // в портал и получили отказ, неотличимый от отозванного доступа.
    const [iv, tag, payload] = encryptSecret('настоящий').split(':') as [string, string, string]
    const flipped = Buffer.from(payload, 'base64')
    flipped[0] = flipped[0]! ^ 0xFF

    expect(() => decryptSecret([iv, tag, flipped.toString('base64')].join(':'))).toThrow()
  })

  it('ловит подменённый тег', () => {
    const [iv, , payload] = encryptSecret('настоящий').split(':') as [string, string, string]

    expect(() => decryptSecret([iv, Buffer.alloc(16).toString('base64'), payload].join(':'))).toThrow()
  })

  it('не принимает обрезанную строку', () => {
    expect(() => decryptSecret('просто строка')).toThrow(/три части/)
  })

  it('не расшифровывает чужим ключом', () => {
    const sealed = encryptSecret('секрет')
    process.env.B24_TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString('base64')

    expect(() => decryptSecret(sealed)).toThrow()
  })

  describe('ключ', () => {
    it('без ключа отказывается шифровать, а не пишет открытым текстом', () => {
      delete process.env.B24_TOKEN_ENC_KEY

      expect(() => encryptSecret('токен')).toThrow(TokenKeyError)
    })

    it.each([16, 48])('отвергает ключ длиной %i байт', (bytes) => {
      // Проверять надо обе стороны: с проверкой «короче 32» слишком длинный ключ
      // дошёл бы до node:crypto, и администратор увидел бы невнятную ошибку вместо нашей.
      process.env.B24_TOKEN_ENC_KEY = Buffer.alloc(bytes, 1).toString('base64')

      expect(() => encryptSecret('токен')).toThrow(TokenKeyError)
    })

    it('принимает и hex, и base64', () => {
      process.env.B24_TOKEN_ENC_KEY = Buffer.alloc(32, 3).toString('hex')
      const sealed = encryptSecret('токен')

      expect(decryptSecret(sealed)).toBe('токен')
    })
  })
})

describe('ротация ключа', () => {
  const OLD = Buffer.alloc(32, 1).toString('base64')
  const NEW = Buffer.alloc(32, 2).toString('base64')

  afterEach(() => {
    delete process.env.B24_TOKEN_ENC_KEY_OLD
  })

  it('читает строки, зашифрованные прежним ключом', () => {
    // Без этого подмена ключа мгновенно делает нечитаемым КАЖДЫЙ токен, то есть каждый
    // портал должен переустановить приложение. Отказ при этом тихий.
    process.env.B24_TOKEN_ENC_KEY = OLD
    const sealed = encryptSecret('токен из прошлой эпохи')

    process.env.B24_TOKEN_ENC_KEY = NEW
    process.env.B24_TOKEN_ENC_KEY_OLD = OLD

    expect(decryptSecret(sealed)).toBe('токен из прошлой эпохи')
  })

  it('шифрует всегда текущим ключом — этим строки и переезжают', () => {
    process.env.B24_TOKEN_ENC_KEY = NEW
    process.env.B24_TOKEN_ENC_KEY_OLD = OLD
    const sealed = encryptSecret('свежий токен')

    delete process.env.B24_TOKEN_ENC_KEY_OLD

    expect(decryptSecret(sealed)).toBe('свежий токен')
  })

  it('сломанный прежний ключ не роняет расшифровку текущим', () => {
    // Отказ здесь был бы строго хуже: опечатка в НЕОБЯЗАТЕЛЬНОЙ переменной уронила бы
    // и строки на рабочем ключе, то есть авторизацию целиком.
    process.env.B24_TOKEN_ENC_KEY = NEW
    const sealed = encryptSecret('токен')
    process.env.B24_TOKEN_ENC_KEY_OLD = 'это-не-ключ'

    expect(decryptSecret(sealed)).toBe('токен')
  })

  it('когда не подошёл ни один ключ, говорит именно это', () => {
    process.env.B24_TOKEN_ENC_KEY = OLD
    const sealed = encryptSecret('токен')
    process.env.B24_TOKEN_ENC_KEY = NEW
    process.env.B24_TOKEN_ENC_KEY_OLD = Buffer.alloc(32, 3).toString('base64')

    // Не ошибка последней попытки: она скрыла бы сам факт перебора.
    expect(() => decryptSecret(sealed)).toThrow(/двух ключей/)
  })
})
