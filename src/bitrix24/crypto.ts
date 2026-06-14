import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

/**
 * Шифрование OAuth-токенов Bitrix24 перед записью в БД (ISSUE #3).
 * AES-256-GCM: конфиденциальность + аутентификация (подделка ciphertext → ошибка
 * расшифровки). Ключ — 32 байта из окружения, в код/логи не попадает. Открытый
 * текст (токены) живёт в памяти только на время использования.
 *
 * Ротация ключа: каждый blob помечен `kid` (короткий отпечаток ключа). Сейчас
 * один активный ключ; формат уже готов к будущему keyring (несколько ключей,
 * routing по kid) — это отдельный ISSUE. При несовпадении `kid` `open()` даёт
 * понятную ошибку вместо невнятного GCM auth-failure.
 */

const ALG = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/** Длина base64-строки в байтах после декодирования (для валидации iv/tag). */
const b64len = (s: string): number => Buffer.from(s, 'base64').length

/** Зашифрованный пакет (хранится как JSONB в `portal.tokens`). */
export const encryptedBlobSchema = z.object({
  alg: z.literal(ALG),
  /** Отпечаток ключа (kid): первые 8 hex SHA-256(key) — для будущей ротации. */
  kid: z.string().min(1),
  iv: z.string().refine((s) => b64len(s) === IV_BYTES, `iv должен быть ${IV_BYTES} байт (base64)`),
  tag: z.string().refine((s) => b64len(s) === TAG_BYTES, `tag должен быть ${TAG_BYTES} байт (base64)`),
  ct: z.string().min(1)
})
export type EncryptedBlob = z.infer<typeof encryptedBlobSchema>

/** kid = первые 8 hex символов SHA-256 от ключа (не раскрывает сам ключ). */
function deriveKid(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

export class TokenCipher {
  private readonly key: Buffer
  /** Отпечаток активного ключа; попадает в каждый blob (`seal`). */
  readonly kid: string

  /** key — ровно 32 байта (AES-256). Используйте loadTokenKey для чтения из env. */
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('TokenCipher: ключ должен быть 32 байта (AES-256)')
    // Копия: внешняя мутация переданного буфера (напр. key.fill(0)) не должна
    // незаметно подменить ключ шифра.
    this.key = Buffer.from(key)
    this.kid = deriveKid(this.key)
  }

  seal(plaintext: string): EncryptedBlob {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALG, this.key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return {
      alg: ALG,
      kid: this.kid,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64')
    }
  }

  /**
   * Расшифровывает; при подделке ciphertext/tag, неверном ключе или несовпадении
   * `kid` (blob зашифрован другим ключом) — бросает.
   */
  open(blob: EncryptedBlob): string {
    if (blob.kid !== this.kid) {
      throw new Error(`TokenCipher: blob зашифрован другим ключом (kid ${blob.kid} ≠ ${this.kid})`)
    }
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
export function loadTokenKey(env: Record<string, string | undefined>, varName = 'NUXT_BITRIX_TOKEN_KEY'): Buffer {
  // trim: хвостовой перевод строки из .env не должен давать ложное «плейсхолдер».
  const raw = env[varName]?.trim()
  if (!raw) throw new Error(`${varName} не задан (openssl rand -hex 32)`)
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${varName}: ожидается 64 hex-символа (32 байта); похоже на плейсхолдер`)
  }
  const key = Buffer.from(raw, 'hex')
  // ZERO_KEY — публичная константа (не секрет), обычное сравнение корректно.
  if (key.equals(ZERO_KEY)) throw new Error(`${varName}: нулевой ключ недопустим`)
  return key
}
