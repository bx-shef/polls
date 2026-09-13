import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import process from 'node:process'
import { logger } from './logger'

/**
 * AES-256-GCM for the portal tokens we are obliged to store.
 *
 * Токены портала — единственное, чья утечка из дампа базы означает доступ к чужой CRM.
 * Поэтому в колонке лежит шифротекст, а ключ в окружении: дамп сам по себе бесполезен.
 * GCM, а не CBC: подменённая строка не расшифруется вовсе, а не превратится в мусор,
 * который мы отправим порталу как токен.
 *
 * Портировано с `client-bank-alfa-by`, `server/utils/secretCrypto.ts`: формат блоба,
 * имена переменных окружения и — главное — **ротация ключа**. Свой первый вариант я написал
 * с версионным префиксом `v1.` вместо второго ключа; префикс ротацию не решает никак.
 * Имена переменных совпадают с соседними намеренно: проекты живут на одном хосте,
 * и оператору не приходится помнить, у кого как называется.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
/** 96 бит — длина, под которую GCM оптимизирован; другая заставляет его хешировать вектор. */
const IV_BYTES = 12

/** Ошибка конфигурации, а не данных: отличается от неудачи расшифровки намеренно. */
export class TokenKeyError extends Error {}

function decodeKey(raw: string, name: string): Buffer {
  // Принимаем hex и base64: первое привычнее для `openssl rand -hex 32`, второе короче.
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (decoded.length !== KEY_BYTES) {
    throw new TokenKeyError(`${name} должен разворачиваться в ${KEY_BYTES} байт, получилось ${decoded.length}.`)
  }
  return decoded
}

/** Текущий ключ. Нет ключа — не шифруем и не пишем открытым текстом. */
function currentKey(): Buffer {
  const raw = process.env.B24_TOKEN_ENC_KEY?.trim() ?? ''
  if (raw === '') {
    throw new TokenKeyError('B24_TOKEN_ENC_KEY не задан — хранить токены портала негде.')
  }
  return decodeKey(raw, 'B24_TOKEN_ENC_KEY')
}

/** Чтобы сломанный запасной ключ не кричал на каждой строке. */
let warnedBadOldKey = false
let warnedPreviousKeyHit = false

/**
 * Ключи для расшифровки: текущий, затем прежний, если задан.
 *
 * ⚠ Без второго ключа ротация физически невозможна: подмена `B24_TOKEN_ENC_KEY` мгновенно
 * делает нечитаемым КАЖДЫЙ сохранённый токен, то есть каждый портал должен переустановить
 * приложение. Отказ при этом тихий — выкатка выглядит успешной, а всплывает на первом
 * же обращении к порталу.
 *
 * ⚠ Сломанный прежний ключ НЕ роняет расшифровку: он пропускается с предупреждением.
 * Отказ здесь был бы строго хуже — опечатка в НЕОБЯЗАТЕЛЬНОЙ переменной сделала бы
 * нечитаемыми и строки на текущем ключе, то есть уронила бы авторизацию целиком.
 */
function decryptionKeys(): Buffer[] {
  const primary = currentKey()
  const old = process.env.B24_TOKEN_ENC_KEY_OLD?.trim() ?? ''
  if (old === '') return [primary]

  try {
    const previous = decodeKey(old, 'B24_TOKEN_ENC_KEY_OLD')
    return previous.equals(primary) ? [primary] : [primary, previous]
  }
  catch (error) {
    if (!warnedBadOldKey) {
      warnedBadOldKey = true
      logger.warn(
        { reason: (error as Error).message },
        'B24_TOKEN_ENC_KEY_OLD не разобран и пропущен: строки на прежнем ключе не прочитаются, текущий работает',
      )
    }
    return [primary]
  }
}

/**
 * Зашифровать секрет для хранения: `iv:tag:шифротекст`, все части base64.
 *
 * Шифруем ВСЕГДА текущим ключом — именно это постепенно переносит строки с прежнего
 * по мере обновления токенов, и именно поэтому окно ротации равно времени жизни
 * `refresh_token`, а не суткам.
 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, currentKey(), iv)
  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])

  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), sealed.toString('base64')].join(':')
}

/**
 * Расшифровать секрет из хранилища.
 *
 * Перебирать ключи безопасно: GCM проверяет тег, и неверный ключ бросает, а не возвращает
 * правдоподобный мусор. Попадание в прежний ключ отмечается один раз за процесс — это
 * и есть сигнал владельцу, что окно ротации ещё открыто.
 */
export function decryptSecret(blob: string): string {
  const parts = blob.split(':')
  if (parts.length !== 3) {
    throw new Error('Секрет повреждён: не три части.')
  }

  const [ivPart, tagPart, payloadPart] = parts as [string, string, string]
  const iv = Buffer.from(ivPart, 'base64')
  const tag = Buffer.from(tagPart, 'base64')
  const payload = Buffer.from(payloadPart, 'base64')
  const keys = decryptionKeys()

  for (const [index, key] of keys.entries()) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
      if (index > 0 && !warnedPreviousKeyHit) {
        warnedPreviousKeyHit = true
        logger.warn('токен расшифрован ПРЕЖНИМ ключом — ротация не закончена, B24_TOKEN_ENC_KEY_OLD ещё нужен')
      }
      return plain
    }
    catch {
      continue
    }
  }

  // Не ошибка последней попытки: она была бы про прежний ключ и скрыла бы сам факт перебора.
  throw new Error(keys.length > 1
    ? 'Ни один из двух ключей не подошёл (B24_TOKEN_ENC_KEY / _OLD).'
    : 'Неверный ключ или повреждённые данные.')
}
