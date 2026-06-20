import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { applySchema } from './helpers/schema'
import { PgStore } from '../src/store/pg'
import type { Queryable } from '../src/store/types'
import { ensureDefaultPortal, seedDemoIfEmpty, LOCAL_PORTAL_MEMBER_ID } from '../src/store/bootstrap'
import { SURVEY_KEY } from '../src/demo/seed'

describe('bootstrap прод-стора (#6, pglite)', () => {
  let pg: PGlite
  let db: Queryable

  beforeAll(async () => {
    pg = new PGlite()
    await applySchema(pg)
    db = pg as unknown as Queryable
  })
  afterAll(async () => {
    await pg.close()
  })
  beforeEach(async () => {
    // CASCADE чистит зависимые таблицы (survey_group/survey/version/response/…) в правильном порядке.
    await db.query('truncate table portal restart identity cascade')
  })

  describe('ensureDefaultPortal', () => {
    it('создаёт портал и возвращает числовой id', async () => {
      const id = await ensureDefaultPortal(db)
      expect(typeof id).toBe('number')
      const r = await db.query<{ member_id: string }>('select member_id from portal where id = $1', [id])
      expect(r.rows[0]?.member_id).toBe(LOCAL_PORTAL_MEMBER_ID)
    })

    it('идемпотентен: повторный вызов даёт ТОТ ЖЕ id (без дубля)', async () => {
      const a = await ensureDefaultPortal(db)
      const b = await ensureDefaultPortal(db)
      expect(b).toBe(a)
      const n = await db.query<{ c: string }>('select count(*)::text as c from portal')
      expect(n.rows[0]?.c).toBe('1')
    })
  })

  describe('seedDemoIfEmpty', () => {
    const responseCount = async (): Promise<number> => {
      const r = await db.query<{ c: string }>('select count(*)::text as c from response')
      return Number(r.rows[0]?.c)
    }

    it('пустой стор → засеивает демо (версия + ответы появляются)', async () => {
      const store = new PgStore(db, { portalId: await ensureDefaultPortal(db) })
      const seeded = await seedDemoIfEmpty(store)
      expect(seeded).toBe(true)
      expect(await store.currentVersion(SURVEY_KEY)).toBeDefined()
      expect(await responseCount()).toBeGreaterThan(0)
    })

    it('повторный вызов — no-op (нет дубликатов ответов)', async () => {
      const store = new PgStore(db, { portalId: await ensureDefaultPortal(db) })
      await seedDemoIfEmpty(store)
      const after1 = await responseCount()
      const seededAgain = await seedDemoIfEmpty(store)
      expect(seededAgain).toBe(false)
      expect(await responseCount()).toBe(after1) // дубликатов нет
    })
  })
})
