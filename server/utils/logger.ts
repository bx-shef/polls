import { pino, type DestinationStream } from 'pino'
import { logLevel } from './env'

/**
 * Field names that must never reach the log, wherever they appear in the object.
 *
 * Инвариант из `CLAUDE.md`: в логи не попадают токены, тексты ответов и идентификаторы
 * клиентов портала. Логи переживают инцидент и утекают вместе с ним, поэтому список
 * закрывающий, а не «на всякий случай».
 */
const SECRET_FIELDS = [
  // токены портала — в разных написаниях, как их отдаёт Битрикс24 и как мы их храним
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'AUTH_ID',
  'REFRESH_ID',
  'auth',
  // токен ссылки на анкету и токен приложения
  'token',
  'application_token',
  // содержимое ответа клиента
  'answer',
  'answers',
  'payload',
  // кто отвечал
  'email',
  'phone',
  'contact',
]

/**
 * Пути redaction: имя поля в корне и на двух уровнях вложенности. Глубже не идём
 * сознательно — вместо бесконечных звёздочек логируем плоские объекты.
 */
export const redactPaths: string[] = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map(field => `*.${field}`),
  ...SECRET_FIELDS.map(field => `*.*.${field}`),
  'req.headers.authorization',
  'req.headers.cookie',
]

/** Creates a logger; the destination is injectable so redaction can be tested. */
export function createLogger(destination?: DestinationStream) {
  const options = {
    level: logLevel(),
    redact: { paths: redactPaths, censor: '[скрыто]' },
  }
  return destination ? pino(options, destination) : pino(options)
}

export const logger = createLogger()
