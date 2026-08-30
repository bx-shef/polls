import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { databaseUrl } from '../utils/env'
import * as schema from './schema'

/**
 * Lazily created singleton connection.
 *
 * Каркас обязан подниматься и без базы: иначе первый же запуск на чистой машине
 * упирается в «нет Postgres» вместо страницы. Отсутствие `DATABASE_URL` — не ошибка,
 * а состояние, о котором честно говорит `/api/health`.
 */
let sql: ReturnType<typeof postgres> | undefined
let db: PostgresJsDatabase<typeof schema> | undefined

export const isDatabaseConfigured = (): boolean => databaseUrl() !== ''

export function getSql() {
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL is not set')
  }
  sql ??= postgres(databaseUrl(), { max: 10, onnotice: () => {} })
  return sql
}

export function getDb(): PostgresJsDatabase<typeof schema> {
  db ??= drizzle(getSql(), { schema })
  return db
}

/** Closes the pool; used by tests and graceful shutdown. */
export async function closeDb(): Promise<void> {
  await sql?.end({ timeout: 5 })
  sql = undefined
  db = undefined
}

export { schema }
