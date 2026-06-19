import { createApi, type Api } from '~core/api/handlers'
import { buildDemo } from '~core/demo/seed'
import { createJsonLogger } from '~core/obs/logger'

/**
 * Nitro-привязка ядрового HTTP-слоя (контур A). SERVER-ONLY: `~core/api`/`~core/store`/
 * `~core/obs` сюда импортируются намеренно (Nitro-роуты), в клиентский бандл не попадают.
 *
 * Логика остаётся в ядре (`createApi`, framework-agnostic) — здесь только инстанс на
 * процесс. Стор: пока демо (MemoryStore + seed, паритет с `pnpm serve`), чтобы контур A
 * имел рабочий бэкенд в dev. Прод-стор (PgStore по `DATABASE_URL`) + общий стор анти-абьюза
 * для мульти-инстанса — слой деплоя (#4, #6). Один логгер JSON в stdout (#5).
 */
let apiPromise: Promise<Api> | undefined

export function useApi(): Promise<Api> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const store = await buildDemo()
      const logger = createJsonLogger({ base: { svc: 'polls' } })
      return createApi({ store, logger })
    })()
  }
  return apiPromise
}
