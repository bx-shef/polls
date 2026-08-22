import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { SURVEY_KEY } from '../src/demo/seed'

/**
 * Демо-данные НЕ попадают в живого арендатора (#47/#49) — исполняемый гард на настоящей проводке.
 *
 * ⚠️ С фолбэком «всегда плейсхолдер» (`ensureDefaultPortal`, решение 2026-08-22) boot на базе с
 * установленным порталом заводит `__local__` РЯДОМ и сеет демо ТУДА — арендатор не получает ни
 * анкеты, ни выдуманных ответов. Дефект, который сторожит тест, невидим снаружи: окажись порталом
 * по умолчанию боевой тенант (регресс выбора фолбэка ИЛИ снятый гейт `isPlaceholderPortal`), boot
 * опубликовал бы ему две версии анкеты и дюжину выдуманных ответов с чужими названиями компаний и
 * ФИО, а ключ демо совпадает с `DEFAULT_SURVEY_KEY`, по которому виджет и робот выписывают
 * приглашения: реальному клиенту ушла бы ссылка на демо-анкету. В логе — одна строка `store_seeded`,
 * отличить от нормы нечем. Возврат прежнего правила «настоящий приоритетнее» тест тоже валит:
 * тогда демо не сеется вовсе и плейсхолдер не заводится.
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
  it('демо сеется в ПЛЕЙСХОЛДЕР, арендатор не получает ничего', async () => {
    const { useStore } = await import('../server/utils/api')
    await useStore() // прогоняет buildStore целиком: миграции → фолбэк-портал → гейт демо → засев

    // Фолбэк завёл плейсхолдер РЯДОМ с арендатором (а не выбрал арендатора).
    const local = await pglite.query<{ id: number }>(
      `select id from portal where member_id = '__local__'`
    )
    expect(local.rows.length, 'плейсхолдер не завёлся — фолбэком стал арендатор').toBe(1)
    const localId = local.rows[0]!.id

    // Демо-опрос опубликован, и опубликован ИМЕННО в плейсхолдер.
    const surveys = await pglite.query<{ c: number }>(
      `select count(*)::int as c from survey s join survey_group g on g.id = s.group_id
        where s.survey_key = $1 and g.portal_id = $2`, [SURVEY_KEY, localId]
    )
    expect(surveys.rows[0]!.c, 'демо-опрос не засеялся в плейсхолдер').toBe(1)

    // У арендатора — ни групп, ни ответов: ни демо, ни чего-либо ещё boot ему не приносит.
    const tenant = await pglite.query<{ groups: number; responses: number }>(
      `select
         (select count(*)::int from survey_group g join portal p on p.id = g.portal_id
           where p.member_id = 'm-tenant') as groups,
         (select count(*)::int from response r join portal p on p.id = r.portal_id
           where p.member_id = 'm-tenant') as responses`
    )
    expect(tenant.rows[0], 'boot принёс данные в боевой тенант').toEqual({ groups: 0, responses: 0 })

    // Выдуманные ответы демо есть — и все под плейсхолдером.
    const responses = await pglite.query<{ total: number; local: number }>(
      `select count(*)::int as total,
              count(*) filter (where portal_id = $1)::int as local
         from response`, [localId]
    )
    expect(responses.rows[0]!.total).toBeGreaterThan(0)
    expect(responses.rows[0]!.local, 'часть демо-ответов легла не в плейсхолдер').toBe(responses.rows[0]!.total)
  }, 60_000)
})
