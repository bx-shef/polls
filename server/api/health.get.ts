import { sql } from 'drizzle-orm'
import { getDb, isDatabaseConfigured } from '../db/client'
import { appVersion } from '../utils/env'
import { logger } from '../utils/logger'
import { getRedis, isRedisConfigured, whenRedisReady } from '../utils/redis'

/**
 * Liveness/readiness probe: одна точка, по которой и Docker, и человек после выкатки
 * видят, поднялось ли приложение и достучалось ли оно до базы и Redis.
 *
 * `off` — зависимость не настроена, это не ошибка: каркас обязан подниматься до того,
 * как поднята инфраструктура. `down` — настроена и не отвечает, вот это 503.
 *
 * Наружу отдаём только состояния. Текст ошибки драйвера несёт имена хостов, порты и
 * причины отказа аутентификации, а эндпоинт открыт анонимно — подробности уезжают
 * в лог, где их вычищает pino.
 */

type CheckStatus = 'ok' | 'down' | 'off'

interface Check {
  status: CheckStatus
  latencyMs?: number
}

/** Таймаут пробы держим больше `connect_timeout` драйвера, чтобы в лог попадала его ошибка, а не наша. */
const PROBE_TIMEOUT_MS = 4000

/**
 * Removes credentials from a connection-string-shaped message.
 *
 * Жадная звёздочка до последней `@` — пароль сам может содержать `@`,
 * и нежадная версия обрезала бы только его начало.
 */
function scrub(message: string): string {
  return message.replace(/\/\/[^/\s]*@/g, '//***@')
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

async function probe(name: string, configured: boolean, run: () => Promise<unknown>): Promise<Check> {
  if (!configured) return { status: 'off' }
  const startedAt = performance.now()
  try {
    await withTimeout(Promise.resolve(run()))
    return { status: 'ok', latencyMs: Math.round(performance.now() - startedAt) }
  }
  catch (error) {
    logger.warn(
      { dependency: name, probeError: scrub(error instanceof Error ? error.message : String(error)) },
      'health probe failed',
    )
    return { status: 'down', latencyMs: Math.round(performance.now() - startedAt) }
  }
}

export default defineEventHandler(async (event) => {
  const [db, redis] = await Promise.all([
    probe('db', isDatabaseConfigured(), () => getDb().execute(sql`select 1`)),
    probe('redis', isRedisConfigured(), async () => {
      // Дожидаемся готовности соединения и только потом шлём команду: иначе при
      // `maxRetriesPerRequest: null` она осядет в офлайн-очереди и не вернётся никогда.
      await whenRedisReady(PROBE_TIMEOUT_MS - 500)
      return await getRedis().ping()
    }),
  ])

  const checks = { db, redis }
  const degraded = Object.values(checks).some(check => check.status === 'down')
  if (degraded) setResponseStatus(event, 503)

  return {
    status: degraded ? 'degraded' : 'ok',
    version: appVersion(),
    checks,
  }
})
