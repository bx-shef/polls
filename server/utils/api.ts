import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApi, type Api } from '~core/api/handlers'
import { buildDemo } from '~core/demo/seed'
import { createJsonLogger, type Logger } from '~core/obs/logger'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { MemoryInvitationStore } from '~core/api/invitation'
import { PgStore, queryableFromPool } from '~core/store/pg'
import { applyMigrations, upSql } from '~core/store/migrate'
import { ensureDefaultPortal, seedDemoIfEmpty } from '~core/store/bootstrap'
import { resolveMemberIdByDomain } from '~core/bitrix24/portal'
import type { IStore, Queryable } from '~core/store/types'
import { setPortalResolver } from './b24-session'

/**
 * Nitro-привязка ядра. SERVER-ONLY: `~core/api`/`~core/store`/`~core/obs`/`~core/bitrix24` сюда
 * импортируются намеренно (Nitro-роуты, гарантия — server-каталог Nuxt), в клиентский бандл не попадают.
 *
 * Стор выбирается по `DATABASE_URL` (#6):
 *  - задан → **PgStore** (PostgreSQL): миграции на boot → tenant-портал → засев демо в пустую БД →
 *    боевой резолвер `domain → member_id` для handshake. Данные СОХРАНЯЮТСЯ между рестартами.
 *  - не задан → **MemoryStore + seed** (dev/демо, паритет с `pnpm serve`; данные эфемерны).
 * ОДИН инстанс на процесс (`useStore`) — общий для `/api/*` (контур A) и дашборда (контур B).
 */
let storePromise: Promise<IStore> | undefined
let apiPromise: Promise<Api> | undefined
/** pg-Queryable активного PgStore (для PortalTokenStore установки, #17); undefined на MemoryStore. */
let pgDb: Queryable | undefined

export const logger: Logger = createJsonLogger({ base: { svc: 'polls' } })

/** pg-Queryable, если приложение на PgStore (DATABASE_URL задан); иначе undefined. Гарантирует инициализацию стора. */
export async function usePortalDb(): Promise<Queryable | undefined> {
  await useStore()
  return pgDb
}

export function useStore(): Promise<IStore> {
  if (!storePromise) {
    storePromise = buildStore().catch((e) => {
      storePromise = undefined
      throw e
    })
  }
  return storePromise
}

/** up-SQL миграций из каталога `migrations/` (в образе COPY'нут в /app/migrations). */
function readMigrationSqls(): string[] {
  const dir = join(process.cwd(), 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => upSql(readFileSync(join(dir, f), 'utf8')))
}

async function buildStore(): Promise<IStore> {
  const url = process.env.DATABASE_URL
  if (!url) {
    // Dev/демо: данные эфемерны. Явный сигнал, если окружение выглядит боевым.
    if (process.env.NODE_ENV === 'production') {
      logger.warn('store_dev_memory', {
        msg: 'DATABASE_URL не задан — MemoryStore+seed (данные эфемерны). Для постоянства задайте DATABASE_URL (#6)'
      })
    }
    return buildDemo()
  }
  // Прод: PostgreSQL. Динамический import — pg тянется только на сервере с заданным DATABASE_URL.
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: url })
  const db: Queryable = queryableFromPool(pool)
  pgDb = db // доступен для PortalTokenStore (установка #17)
  await applyMigrations(db, readMigrationSqls())
  const portalId = await ensureDefaultPortal(db)
  const store = new PgStore(db, { portalId })
  if (await seedDemoIfEmpty(store)) {
    logger.info('store_seeded', { msg: 'Демо-опрос засеян в пустую БД (single-tenant MVP, #6)' })
  }
  // Боевой резолвер handshake app-фрейма: domain → member_id из таблицы portal (#47/#49).
  setPortalResolver((domain) => resolveMemberIdByDomain(db, domain))
  logger.info('store_pg', { msg: 'PgStore активен (PostgreSQL) — данные сохраняются между рестартами' })
  return store
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

/**
 * ОБЩИЙ стор приглашений на процесс: его пишет триггер/виджет (создаёт приглашение по сделке) и
 * расходует `submit` — поэтому createApi получает ИМЕННО этот инстанс, а не создаёт свой.
 * In-memory (один инстанс); durable-стор приглашений в БД — #4.
 */
let invitationStore: MemoryInvitationStore | undefined
export function useInvitations(): MemoryInvitationStore {
  if (!invitationStore) invitationStore = new MemoryInvitationStore()
  return invitationStore
}

async function buildApi(): Promise<Api> {
  const store = await useStore()
  // Щедрый лимитер для dev/gate-сервера: SSR-рендер сам дёргает /api/survey/:key/current
  // (server-to-server, один loopback-IP), и визуальный гейт прогоняет страницу многократно —
  // дефолтные 10/60с быстро упираются в 429 (флаки гейта). Это НЕ прод-граница анти-абьюза
  // (она по IP за доверенным прокси + общий стор — #4/#6); здесь высокий потолок убирает
  // ложные 429, оставляя ceiling от примитивного флуда.
  const limiter = new SlidingWindowLimiter({ limit: 1000, windowMs: 60_000 })
  return createApi({ store, logger, limiter, invitations: useInvitations() })
}
