import { Buffer } from 'node:buffer'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Предупреждения о ротации ключа — отдельным файлом, и на это две причины.
 *
 * Первая: оба флага одноразовые на процесс, и соседние тесты из `token-crypto.test.ts`
 * израсходовали бы их раньше, чем дело дойдёт до проверки. `vitest` изолирует файлы,
 * поэтому здесь модуль поднимается заново.
 *
 * Вторая: проверять это нужно, хотя функционально без предупреждений ничего не ломается —
 * расшифровка проходит, тесты зелёные. Но это единственный сигнал владельцу, что
 * `B24_TOKEN_ENC_KEY_OLD` ещё нужен: `.env.example` прямо велит убирать его, «когда из
 * логов пропадёт предупреждение». Пропадёт оно и тогда, когда строку случайно удалят, —
 * и ключ снимут с живыми строками на нём. Это тихая потеря доступа ко всем порталам.
 */

const warn = vi.fn()
vi.mock('../../server/utils/logger', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }))

const OLD = Buffer.alloc(32, 4).toString('base64')
const NEW = Buffer.alloc(32, 5).toString('base64')

let saved: string | undefined

beforeEach(() => {
  saved = process.env.B24_TOKEN_ENC_KEY
  warn.mockClear()
})

afterEach(() => {
  if (saved === undefined) delete process.env.B24_TOKEN_ENC_KEY
  else process.env.B24_TOKEN_ENC_KEY = saved
  delete process.env.B24_TOKEN_ENC_KEY_OLD
})

/** Текст всех предупреждений одной строкой: pino пишет мимо `process.stdout`, ловим на входе. */
function warned(): string {
  return warn.mock.calls.map(call => JSON.stringify(call)).join(' ')
}

describe('сигналы ротации ключа', () => {
  it('говорит, что строка расшифрована прежним ключом', async () => {
    const { decryptSecret, encryptSecret } = await import('../../server/utils/crypto')
    process.env.B24_TOKEN_ENC_KEY = OLD
    const sealed = encryptSecret('токен')

    process.env.B24_TOKEN_ENC_KEY = NEW
    process.env.B24_TOKEN_ENC_KEY_OLD = OLD
    expect(decryptSecret(sealed)).toBe('токен')

    expect(warned()).toContain('ПРЕЖНИМ ключом')
  })

  it('говорит, что прежний ключ не разобран и пропущен', async () => {
    const { decryptSecret, encryptSecret } = await import('../../server/utils/crypto')
    process.env.B24_TOKEN_ENC_KEY = NEW
    const sealed = encryptSecret('токен')

    process.env.B24_TOKEN_ENC_KEY_OLD = 'это-не-ключ'
    expect(decryptSecret(sealed)).toBe('токен')

    expect(warned()).toContain('не разобран')
  })
})
