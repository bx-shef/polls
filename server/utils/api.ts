import { createApi, type Api } from '~core/api/handlers'
import { buildDemo } from '~core/demo/seed'
import { createJsonLogger } from '~core/obs/logger'
import { SlidingWindowLimiter } from '~core/api/ratelimit'

/**
 * Nitro-привязка ядрового HTTP-слоя (контур A). SERVER-ONLY: `~core/api`/`~core/store`/
 * `~core/obs` сюда импортируются намеренно (Nitro-роуты, гарантия — server-каталог Nuxt),
 * в клиентский бандл не попадают.
 *
 * Логика остаётся в ядре (`createApi`, framework-agnostic) — здесь только инстанс на
 * процесс. Стор: пока демо (MemoryStore + seed, паритет с `pnpm serve`), чтобы контур A
 * имел рабочий бэкенд в dev. Прод-стор (PgStore по `DATABASE_URL`) + общий стор анти-абьюза
 * для мульти-инстанса — слой деплоя (#4, #6). Один логгер JSON в stdout (#5).
 */
let apiPromise: Promise<Api> | undefined

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
  const store = await buildDemo()
  // Щедрый лимитер для dev/gate-сервера: SSR-рендер сам дёргает /api/survey/:key/current
  // (server-to-server, один loopback-IP), и визуальный гейт прогоняет страницу многократно —
  // дефолтные 10/60с быстро упираются в 429 (флаки гейта). Это НЕ прод-граница анти-абьюза
  // (она по IP за доверенным прокси + общий стор — #4/#6); здесь высокий потолок убирает
  // ложные 429, оставляя ceiling от примитивного флуда.
  const limiter = new SlidingWindowLimiter({ limit: 1000, windowMs: 60_000 })
  return createApi({ store, logger, limiter })
}
