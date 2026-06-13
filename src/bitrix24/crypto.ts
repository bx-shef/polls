import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/**
 * Шифрование OAuth-токенов Bitrix24 перед записью в БД (ISSUE #3).
 * AES-256-GCM: конфиденциальность + аутентификация (подделка ciphertext → ошибка
 * расшифровки). Ключ — 32 байта из окружения, в код/логи не попадает. Открытый
 * текст (токены) живёт в памяти только на время использования.
 */

const ALG = 'aes-256-gcm'

/** Зашифрованный пакет (хранится как JSONB в `portal.tokens`). */
export const encryptedBlobSchema = z.object({
  alg: z.literal(ALG),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ct: z.string()
})
export type EncryptedBlob = z.infer<typeof encryptedBlobSchema>

export class TokenCipher {
  /** key — ровно 32 байта (AES-256). Используйте loadTokenKey для чтения из env. */
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('TokenCipher: ключ должен быть 32 байта (AES-256)')
  }

  seal(plaintext: string): EncryptedBlob {
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALG, this.key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return {
      alg: ALG,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64')
    }
  }

  /** Расшифровывает; при подделке ciphertext/tag или неверном ключе — бросает. */
  open(blob: EncryptedBlob): string {
    const decipher = createDecipheriv(ALG, this.key, Buffer.from(blob.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]).toString('utf8')
  }
}

const ZERO_KEY = Buffer.alloc(32)

/**
 * Читает и валидирует ключ шифрования из окружения (startup-guard, ISSUE #3):
 * 64 hex-символа (32 байта), не плейсхолдер, не нулевой. Приложение должно
 * вызывать это на старте и падать с понятной ошибкой, а не работать со слабым ключом.
 */
export function loadTokenKey(
  env: Record<string, string | undefined>,
  varName = 'NUXT_BITRIX_TOKEN_KEY'
): Buffer {
  const raw = env[varName]
  if (!raw || raw.trim() === '') throw new Error(`${varName} не задан (openssl rand -hex 32)`)
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${varName}: ожидается 64 hex-символа (32 байта); похоже на плейсхолдер`)
  }
  const key = Buffer.from(raw, 'hex')
  if (timingSafeEqual(key, ZERO_KEY)) throw new Error(`${varName}: нулевой ключ недопустим`)
  return key
}
