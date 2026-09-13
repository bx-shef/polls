import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import process from 'node:process'

/**
 * Symmetric sealing for the portal tokens we are obliged to store.
 *
 * Токены портала — единственное, что мы обязаны держать у себя, и единственное, чья утечка
 * из дампа базы означает доступ к чужой CRM. Поэтому в колонке лежит шифротекст, а ключ —
 * в окружении: дамп базы сам по себе бесполезен.
 *
 * AES-256-GCM, а не CBC: GCM аутентифицирует шифротекст, и подменённая строка в базе
 * не расшифруется в мусор, который мы потом отправим порталу как токен, — она не
 * расшифруется вовсе.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
/** 96 бит — длина, под которую GCM оптимизирован; другая заставляет его хешировать вектор. */
const IV_BYTES = 12
/**
 * Версия формата в самой строке.
 *
 * Смена ключа или алгоритма когда-нибудь понадобится, и тогда придётся отличать старые
 * записи от новых. Один префикс сейчас стоит ничего; разбор «что это за строка» на живой
 * базе с миллионом записей стоит дорого.
 */
const FORMAT = 'v1'

/** Ошибка конфигурации, а не данных: отличается от неудачи расшифровки намеренно. */
export class TokenKeyError extends Error {}

function key(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY ?? ''
  if (raw === '') {
    throw new TokenKeyError('TOKEN_ENC_KEY не задан — хранить токены портала негде.')
  }

  // Принимаем и base64, и hex: первое короче в `.env`, второе привычнее для `openssl rand -hex 32`.
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (decoded.length !== KEY_BYTES) {
    throw new TokenKeyError(`TOKEN_ENC_KEY должен разворачиваться в ${KEY_BYTES} байт, получилось ${decoded.length}.`)
  }
  return decoded
}

/**
 * Зашифровать секрет для хранения.
 *
 * Возвращает `v1.<iv>.<tag>.<шифротекст>` в base64url — строка целиком помещается
 * в текстовую колонку и не требует отдельных полей под вектор и тег.
 */
export function sealSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])

  return [
    FORMAT,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    sealed.toString('base64url'),
  ].join('.')
}

/**
 * Расшифровать секрет из хранилища.
 *
 * Бросает при любой порче: чужой формат, обрезанная строка, несошедшийся тег. Токен,
 * расшифрованный «почти правильно», хуже отсутствующего — с ним мы пойдём в портал
 * и получим отказ, который выглядит как отозванный доступ.
 */
export function openSecret(packed: string): string {
  const parts = packed.split('.')
  if (parts.length !== 4) {
    throw new Error('Секрет повреждён: не четыре части.')
  }

  const [format, iv, tag, payload] = parts as [string, string, string, string]
  // Сравнение версии — константное по времени не нужно, она не секрет; а вот
  // молча принять чужой формат нельзя.
  if (format !== FORMAT) {
    throw new Error(`Секрет другого формата: ${format}.`)
  }

  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8')
}

/**
 * Сравнение секретов без утечки по времени.
 *
 * Нужно для `application_token`: обработчик событий открыт наружу, и обычное `===`
 * на длинной строке отвечает тем быстрее, чем раньше разошлись байты. Это измеримо
 * и по этому подбирают.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // Разная длина сама по себе не секрет, а `timingSafeEqual` на ней бросает.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
