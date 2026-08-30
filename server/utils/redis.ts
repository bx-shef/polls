import { Redis } from 'ioredis'
import { redisUrl } from './env'
import { logger } from './logger'

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
  if (!client) {
    // maxRetriesPerRequest: null — требование BullMQ; ретраи живут в очереди, а не в транспорте.
    client = new Redis(redisUrl(), { maxRetriesPerRequest: null })

    // Без своего обработчика ioredis печатает ошибки соединения прямо в консоль —
    // мимо pino и мимо его вырезания секретов. Канал, который никто не видит,
    // и в который однажды уедет то, чего там быть не должно.
    client.on('error', error => logger.warn({ redisError: error.message }, 'redis connection error'))
  }
  return client
}

/**
 * Resolves once the connection is usable, rejects on timeout.
 *
 * Ждём событие, а не шлём команду вслепую: при `maxRetriesPerRequest: null` команда,
 * отправленная в отключённый Redis, не отклоняется никогда — она копится в офлайн-очереди.
 * Health-проверка ходит раз в тридцать секунд, и такая очередь растёт бесконечно.
 */
export function whenRedisReady(timeoutMs: number): Promise<void> {
  const redis = getRedis()
  if (redis.status === 'ready') return Promise.resolve()

  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`redis is not ready: ${redis.status}`))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      redis.off('ready', onReady)
    }

    redis.once('ready', onReady)
  })
}
