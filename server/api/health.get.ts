import { sql } from 'drizzle-orm'
import { getDb, isDatabaseConfigured } from '../db/client'
import { appVersion } from '../utils/env'
import { logger } from '../utils/logger'
import { getRedis, isRedisConfigured } from '../utils/redis'

/**
 * Liveness/readiness probe: одна точка, по которой и Docker, и человек после деплоя
 * видят, поднялось ли приложение и достучалось ли оно до базы и Redis.
 *
 * `off` — зависимость не настроена, это не ошибка: каркас обязан подниматься до того,
 * как поднята инфраструктура. `down` — настроена и не отвечает, вот это 503.
 */

type CheckStatus = 'ok' | 'down' | 'off'

interface Check {
  status: CheckStatus
  latencyMs?: number
  error?: string
}

const PROBE_TIMEOUT_MS = 2000

/** Ошибка подключения несёт строку подключения с паролем — вырезаем до того, как отдать наружу. */
function scrub(message: string): string {
  return message.replace(/\/\/[^@\s/]*@/g, '//***@')
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

async function probe(configured: boolean, run: () => Promise<unknown>): Promise<Check> {
  if (!configured) return { status: 'off' }
  const startedAt = performance.now()
  try {
    await withTimeout(Promise.resolve(run()))
    return { status: 'ok', latencyMs: Math.round(performance.now() - startedAt) }
  }
  catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error))
    logger.warn({ probeError: message }, 'health probe failed')
    return { status: 'down', latencyMs: Math.round(performance.now() - startedAt), error: message }
  }
}

export default defineEventHandler(async (event) => {
  const [db, redis] = await Promise.all([
    probe(isDatabaseConfigured(), () => getDb().execute(sql`select 1`)),
    probe(isRedisConfigured(), () => getRedis().ping()),
  ])

  const checks = { db, redis }
  const degraded = Object.values(checks).some(check => check.status === 'down')
  if (degraded) setResponseStatus(event, 503)

  return {
    status: degraded ? 'degraded' : 'ok',
    version: appVersion(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  }
})
