import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * Проводка приглашений (#4) — ИСПОЛНЯЕМЫЙ гард, а не греп по исходнику.
 *
 * ⚠️ Проверяет ровно то обещание, ради которого затевался переезд: при заданном `DATABASE_URL`
 * приглашение доезжает ДО БАЗЫ, под тем же порталом, что и остальные данные, и чистка ПДн этот стор
 * находит. Без такого гарда «выключить переезд целиком» — правка одной строки, и все 1130 тестов
 * остаются зелёными: приложение работает как работало, просто ссылки снова умирают на каждом мерже.
 *
 * Приём с `alter sequence portal_id_seq restart with 77` не украшение: он даёт `portal_id ≠ 1`,
 * поэтому захардкоженная в сторе константа перестаёт совпадать; без сдвига эта мутация выживала.
 * Мокается ровно один модуль — драйвер `pg`: вместо сокета к Postgres пул ходит в pglite.
 * Всё остальное — настоящий `server/utils/api.ts`: миграции, ensureDefaultPortal, LazyInvitationStore.
 */
const pglite = new PGlite()
class FakePool {
  static failNext = false
  constructor(_o: unknown) { if (FakePool.failNext) { FakePool.failNext = false; throw new Error('pg down') } }
  on(): void {}
  async query(sql: string, params?: unknown[]) {
    if (params === undefined) { const r = await pglite.exec(sql); return r[r.length - 1] ?? { rows: [] } } // мультистейтмент миграций
    return pglite.query(sql, params)
  }
  connect() { return Promise.resolve({ query: (s: string, p?: unknown[]) => pglite.query(s, p), release: () => {} }) }
}
vi.mock('pg', () => ({ default: { Pool: FakePool }, Pool: FakePool }))

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://fake/fake'
  // Схема накатывается ЗАРАНЕЕ, а последовательность id портала сдвигается: так проводка
  // (а) повторно проигрывает миграции поверх готовой схемы — ровно как boot на каждом старте (#4),
  // (б) получает portal_id ≠ 1, и захардкоженная константа в конструкторе стора уже не сойдётся.
  const { applySchema } = await import('./helpers/schema')
  await applySchema(pglite)
  await pglite.exec('alter sequence portal_id_seq restart with 77')
})
afterAll(async () => { delete process.env.DATABASE_URL; await pglite.close() })

describe('проводка приглашений', () => {
  it('с DATABASE_URL useInvitations() пишет в БД под НАСТОЯЩИМ порталом', async () => {
    const { useInvitations, usePortalDb } = await import('../server/utils/api')
    const inv = await useInvitations().create(
      { surveyKey: 'csat_postdeal', versionNo: 1, context: { dealId: 42, responsibleName: 'Иванов' } },
      new Date('2026-08-15T10:00:00Z')
    )
    const { rows } = await pglite.query<{ c: number; portal_id: number }>(
      'select count(*)::int as c, min(portal_id)::int as portal_id from invitation'
    )
    expect(rows[0]!.c, 'приглашение не доехало до БД — стор остался в памяти').toBe(1)
    const p = await pglite.query<{ id: number }>('select id from portal')
    expect(p.rows[0]!.id).toBe(77)
    expect(rows[0]!.portal_id, 'portal_id приглашения разошёлся с реальным порталом').toBe(77)

    // Чистка ПДн ходит НАПРЯМУЮ соединением, без стора портала (#49): подметать надо всех
    // арендаторов, а стор скоуплен конструктором.
    const db = await usePortalDb()
    expect(db, 'usePortalDb() пуст при заданном DATABASE_URL — чистка ПДн не пойдёт').toBeDefined()
    const { sweepAllPortalsInvitations } = await import('../src/store/pg-invitation')
    expect(await sweepAllPortalsInvitations(db!, new Date('2026-08-20T00:00:00Z'), 30)).toBe(0) // живое не трогаем
    expect(await useInvitations().peek(inv.token, new Date('2026-08-15T10:01:00Z'))).toBeDefined()
  }, 60_000)

  it('провал резолва НЕ кэшируется — следующий вызов пробует снова', async () => {
    vi.resetModules()
    FakePool.failNext = true
    const { useInvitations } = await import('../server/utils/api')
    const store = useInvitations() // ТОТ ЖЕ инстанс порта на оба вызова
    const args = [{ surveyKey: 'csat_postdeal', versionNo: 1, context: {} }, new Date('2026-08-15T10:00:00Z')] as const
    await expect(store.create(...args)).rejects.toThrow('pg down')
    await expect(store.create(...args), 'провал закэширован: приглашения мертвы до рестарта').resolves.toBeDefined()
  }, 60_000)
})
