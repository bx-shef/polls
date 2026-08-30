import { Redis } from 'ioredis'
import { redisUrl } from './env'

/**
 * Lazily created singleton connection.
 *
 * Как и база, Redis не обязателен для старта: очередей в каркасе ещё нет,
 * а `/api/health` скажет, настроен он или нет.
 */
let client: Redis | undefined

export const isRedisConfigured = (): boolean => redisUrl() !== ''

export function getRedis(): Redis {
  if (!isRedisConfigured()) {
    throw new Error('REDIS_URL is not set')
  }
  // maxRetriesPerRequest: null — требование BullMQ; ретраи живут в очереди, а не в транспорте.
  client ??= new Redis(redisUrl(), { maxRetriesPerRequest: null, lazyConnect: true })
  return client
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => {})
  client = undefined
}
