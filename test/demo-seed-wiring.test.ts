import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { SURVEY_KEY } from '../src/demo/seed'

/**
 * Демо-данные НЕ попадают в живого арендатора (#47/#49) — исполняемый гард на настоящей проводке.
 *
 * ⚠️ Дефект, который он закрывает, достижим штатно и невидим снаружи. Портал по умолчанию с
 * мультитенантом — самый ранний НАСТОЯЩИЙ портал; обычное удаление приложения с очисткой сносит его
 * строку и сбрасывает кэш стора, и следующий же запрос делает порталом по умолчанию СЛЕДУЮЩЕГО
 * арендатора. У него демо-опроса нет — и boot опубликовал бы ему две версии анкеты и дюжину
 * выдуманных ответов с чужими названиями компаний и ФИО. Дальше ключ демо совпадает с
 * `DEFAULT_SURVEY_KEY`, по которому виджет и робот выписывают приглашения: реальному клиенту ушла бы
 * ссылка на демо-анкету, а дашборд смешал бы выдуманные ответы с настоящими. В логе — одна строка
 * `store_seeded`, отличить от нормы нечем.
 *
 * Мокается один модуль — драйвер `pg`; всё остальное настоящее (`buildStore`, миграции, гейт демо).
 */
const pglite = new PGlite()
class FakePool {
  constructor(_o: unknown) {}
  on(): void {}
  async query(sql: string, params?: unknown[]) {
    if (params === undefined) { const r = await pglite.exec(sql); return r[r.length - 1] ?? { rows: [] } }
    return pglite.query(sql, params)
  }
  connect() { return Promise.resolve({ query: (s: string, p?: unknown[]) => pglite.query(s, p), release: () => {} }) }
}
vi.mock('pg', () => ({ default: { Pool: FakePool }, Pool: FakePool }))

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://fake/fake'
  const { applySchema } = await import('./helpers/schema')
  await applySchema(pglite)
  // Единственный портал — НАСТОЯЩИЙ (установленное приложение) и без единого опроса. Ровно то
  // состояние, в котором оказывается второй арендатор после ухода первого.
  await pglite.query(
    `insert into portal (member_id, domain, tokens) values ('m-tenant', 'tenant.bitrix24.ru', '{}'::jsonb)`
  )
})
afterAll(async () => { delete process.env.DATABASE_URL; await pglite.close() })

describe('засев демо-данных', () => {
  it('в НАСТОЯЩИЙ портал демо не сеется', async () => {
    const { useStore } = await import('../server/utils/api')
    await useStore() // прогоняет buildStore целиком: миграции → портал по умолчанию → гейт демо

    const surveys = await pglite.query<{ c: number }>(
      'select count(*)::int as c from survey where survey_key = $1', [SURVEY_KEY]
    )
    expect(surveys.rows[0]!.c, 'демо-опрос опубликован в данных арендатора').toBe(0)

    const responses = await pglite.query<{ c: number }>('select count(*)::int as c from response')
    expect(responses.rows[0]!.c, 'выдуманные ответы легли в данные арендатора').toBe(0)

    // Плейсхолдер при этом НЕ заводится: настоящий портал есть, фолбэк-стор пишет под него.
    const portals = await pglite.query<{ c: number }>('select count(*)::int as c from portal')
    expect(portals.rows[0]!.c).toBe(1)
  }, 60_000)
})
