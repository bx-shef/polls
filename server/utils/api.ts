import { createApi, type Api } from '~core/api/handlers'
import { buildDemo } from '~core/demo/seed'
import { createJsonLogger } from '~core/obs/logger'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import type { IStore } from '~core/store/types'

/**
 * Nitro-привязка ядра. SERVER-ONLY: `~core/api`/`~core/store`/`~core/obs` сюда импортируются
 * намеренно (Nitro-роуты, гарантия — server-каталог Nuxt), в клиентский бандл не попадают.
 *
 * Логика остаётся в ядре (`createApi`, framework-agnostic) — здесь только инстанс на процесс.
 * Стор: пока демо (MemoryStore + seed, паритет с `pnpm serve`). ОДИН инстанс на процесс
 * (`useStore`) — общий для `/api/*` (контур A) и дашборда (контур B), чтобы дашборд видел
 * отправленные ответы. Прод-стор (PgStore по `DATABASE_URL`) + общий стор анти-абьюза — #4/#6.
 */
let storePromise: Promise<IStore> | undefined
let apiPromise: Promise<Api> | undefined

export function useStore(): Promise<IStore> {
  if (!storePromise) {
    storePromise = buildDemo().catch((e) => {
      storePromise = undefined
      throw e
    })
  }
  return storePromise
}

export function useApi(): Promise<Api> {
  if (!apiPromise) {
    // Проваленную инициализацию НЕ кэшируем (иначе сервер не поднимется без рестарта).
    apiPromise = buildApi().catch((e) => {
      apiPromise = undefined
      throw e
    })
  }
  return apiPromise
}

async function buildApi(): Promise<Api> {
  const logger = createJsonLogger({ base: { svc: 'polls' } })
  // Dev-стор: данные эфемерны. Явный сигнал, если окружение выглядит боевым — чтобы тихий
  // запуск без PgStore (#6) не утёк незамеченным (потеря ответов на рестарте).
  if (process.env.DATABASE_URL || process.env.NODE_ENV === 'production') {
    logger.warn('store_dev_memory', {
      msg: 'Nitro-слой использует MemoryStore+seed (данные эфемерны); PgStore по DATABASE_URL — #6'
    })
  }
  const store = await useStore()
  // Щедрый лимитер для dev/gate-сервера: SSR-рендер сам дёргает /api/survey/:key/current
  // (server-to-server, один loopback-IP), и визуальный гейт прогоняет страницу многократно —
  // дефолтные 10/60с быстро упираются в 429 (флаки гейта). Это НЕ прод-граница анти-абьюза
  // (она по IP за доверенным прокси + общий стор — #4/#6); здесь высокий потолок убирает
  // ложные 429, оставляя ceiling от примитивного флуда.
  const limiter = new SlidingWindowLimiter({ limit: 1000, windowMs: 60_000 })
  return createApi({ store, logger, limiter })
}
