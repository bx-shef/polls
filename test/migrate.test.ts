import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { applySchema, migrationSqls, upSql } from './helpers/schema'

// upSql — зеркало node-pg-migrate (dist/legacy/sqlMigration.js getActions). Эти кейсы
// фиксируют поведение, чтобы первая миграция с Up/Down-секциями (#17) применялась в
// тестах ровно так же, как node-pg-migrate накатит её на боевой Postgres.
describe('upSql — разбор маркеров', () => {
  it('без маркеров — весь файл', () => {
    expect(upSql('create table t ();')).toBe('create table t ();')
  })

  it('Up + Down — только up-секция (до маркера Down)', () => {
    const sql = '-- Up Migration\ncreate table t ();\n-- Down Migration\ndrop table t;'
    expect(upSql(sql)).toBe('-- Up Migration\ncreate table t ();\n')
  })

  it('только Up — от маркера до конца', () => {
    const sql = '-- Up Migration\ncreate table t ();'
    expect(upSql(sql)).toBe(sql)
  })

  it('Down без Up — ВЕСЬ файл (как node-pg-migrate), а не срез до Down', () => {
    const sql = 'create table t ();\n-- Down Migration\ndrop table t;'
    expect(upSql(sql)).toBe(sql)
  })

  it('регистр и лишние дефисы в маркере не важны', () => {
    const sql = '--- up migration\ncreate table t ();\n--- down migration\ndrop table t;'
    expect(upSql(sql)).toBe('--- up migration\ncreate table t ();\n')
  })
})

describe('migrationSqls / applySchema (pglite)', () => {
  it('находит миграции, и они содержат DDL', () => {
    const sqls = migrationSqls()
    expect(sqls.length).toBeGreaterThan(0)
    expect(sqls.join('\n')).toMatch(/create table/i)
  })

  it('applySchema создаёт схему в pglite (таблица response существует)', async () => {
    const pg = new PGlite()
    await applySchema(pg)
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_name = 'response'"
    )
    expect(rows[0]?.n).toBe(1)
    await pg.close()
  })
})

describe('applyMigrations — boot-применение (#6)', () => {
  it('прогоняет SQL по порядку через Queryable.query', async () => {
    const { applyMigrations } = await import('../src/store/migrate')
    const calls: string[] = []
    await applyMigrations({ query: async (sql: string) => { calls.push(sql); return { rows: [] } } }, ['a', 'b', 'c'])
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('пустой список → нет вызовов', async () => {
    const { applyMigrations } = await import('../src/store/migrate')
    let n = 0
    await applyMigrations({ query: async () => { n++; return { rows: [] } } }, [])
    expect(n).toBe(0)
  })
})
