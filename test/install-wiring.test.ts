import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * Проводка установки портала — ИСПОЛНЯЕМЫЙ гард, а не греп по исходнику.
 *
 * ⚠️ Присвоение плейсхолдера, ради которого файл заводился, СНЯТО (решение владельца, 2026-08-22,
 * разбор — `test/uninstall-erases-pii.test.ts`, шапка). Файл остался сторожить обратное: установка
 * НИКОГДА не трогает чужие строки, а данные, накопленные до установки, остаются за плейсхолдером.
 *
 * Мокается один модуль — драйвер `pg`: вместо сокета к Postgres пул ходит в pglite. Всё остальное —
 * настоящие `server/utils/api.ts` и `server/utils/portal.ts`: миграции, `ensureDefaultPortal`,
 * `PortalTokenStore` как в бою.
 */
const pglite = new PGlite()
class FakePool {
  constructor(_o: unknown) {}
  on(): void {}
  async query(sql: string, params?: unknown[]) {
    if (params === undefined) { const r = await pglite.exec(sql); return r[r.length - 1] ?? { rows: [] } }
    return pglite.query(sql, params)
  }
  connect() {
    return Promise.resolve({ query: (s: string, p?: unknown[]) => pglite.query(s, p), release: () => {} })
  }
}
vi.mock('pg', () => ({ default: { Pool: FakePool }, Pool: FakePool }))

const KEY_HEX = 'a'.repeat(64)

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://fake/fake'
  process.env.NUXT_BITRIX_TOKEN_KEY = KEY_HEX
  const { applySchema } = await import('./helpers/schema')
  await applySchema(pglite)
})
afterAll(async () => {
  delete process.env.DATABASE_URL
  delete process.env.NUXT_BITRIX_TOKEN_KEY
  await pglite.close()
})

describe('проводка установки: плейсхолдер и его данные остаются нетронутыми', () => {
  it('установка заводит СВОЮ строку, автономные данные остаются за плейсхолдером', async () => {
    const { useStore } = await import('../server/utils/api')
    const { usePortalTokenStore } = await import('../server/utils/portal')
    const { SURVEY_KEY, draftV2 } = await import('../src/demo/seed')

    // Инстанс поднялся до связки с Bitrix и накопил данные под плейсхолдером.
    const store = await useStore()
    if (!(await store.currentVersion(SURVEY_KEY))) await store.publish(draftV2(), 2)
    await store.addResponse({
      id: 'r-wiring',
      surveyKey: SURVEY_KEY,
      versionNo: 2,
      submittedAt: '2026-08-20T10:00:00.000Z',
      context: { dealId: 759, responsibleName: 'Иванов' },
      answers: []
    })
    const before = await pglite.query<{ n: number }>('select count(*)::int as n from response')
    expect(before.rows[0]!.n, 'нечего проверять — данные не накопились').toBeGreaterThan(0)

    // Установка ТЕМ ЖЕ путём, что роут: обычный upsert по своему member_id, без опций присвоения.
    const tokenStore = await usePortalTokenStore()
    expect(tokenStore, 'стор токенов не поднялся — тест ничего не проверит').toBeTruthy()
    const saved = await tokenStore!.save(
      {
        memberId: 'member-wiring-000000000000000',
        domain: 'acme.bitrix24.ru',
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2026-08-20T11:00:00.000Z'
      },
      { eventTs: 1_766_000_000 }
    )
    expect(saved).toBe(true)

    // ⚠️ Обе строки на месте: установка НЕ присвоила плейсхолдер (прежнее поведение было дырой #183 —
    // в Маркете install-URL один на всех, и накопленное забирал первый установившийся).
    const rows = await pglite.query<{ member_id: string }>('select member_id from portal order by id')
    expect(rows.rows.map((r) => r.member_id), 'установка тронула строку плейсхолдера')
      .toEqual(['__local__', 'member-wiring-000000000000000'])
    const after = await pglite.query<{ n: number }>('select count(*)::int as n from response')
    expect(after.rows[0]!.n, 'автономные данные пропали при установке').toBe(before.rows[0]!.n)
  }, 60_000)
})

