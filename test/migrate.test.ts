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

describe('идемпотентность каталога миграций', () => {
  it('каталог применяется ТРИЖДЫ подряд без ошибок', async () => {
    // ⚠️ Это гейт на всю модель деплоя, а не «ещё один тест». Журнала применённых миграций на boot
    // нет: `applyMigrations` проигрывает ВЕСЬ каталог при каждом старте контейнера. Значит любая
    // неидемпотентная миграция (DROP/RENAME/ADD без IF NOT EXISTS) роняет не один запуск, а КАЖДЫЙ
    // следующий — то есть под watchtower это crash-loop на живом проде. Один разовый ручной прогон
    // такое не удержит: гарантия нужна следующему автору миграции, а не текущему.
    const pg = new PGlite()
    try {
      await applySchema(pg)
      await applySchema(pg)
      await applySchema(pg)
      const r = await pg.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name = 'invitation'")
      expect(r.rows[0]!.n).toBe(1)
    } finally {
      await pg.close()
    }
  })

  it('старая строка из схемы 0001 переживает применение новых миграций', async () => {
    // Откат образа под watchtower: схему он не откатывает, значит новая схема обязана работать со
    // строками, заведёнными старым кодом. Проверяем на строке с ОТКРЫТЫМ токеном (так писала 0001).
    const pg = new PGlite()
    try {
      for (const sql of migrationSqls().slice(0, 4)) await pg.exec(sql)
      await pg.exec(`insert into portal (member_id, domain, tokens) values ('old', 'old.b24', '{}'::jsonb)`)
      await pg.exec(`insert into survey_group (portal_id, title) values (1, 'г')`)
      await pg.exec(`insert into survey (group_id, survey_key, title) values (1, 'k', 'т')`)
      await pg.exec(`insert into survey_version (survey_id, version_no) values (1, 1)`)
      await pg.exec(`insert into invitation (portal_id, survey_id, survey_version_id, token)
                     values (1, 1, 1, 'СТАРЫЙ-ОТКРЫТЫЙ-ТОКЕН')`)
      await applySchema(pg)
      const r = await pg.query<{ token: string | null }>('select token from invitation')
      expect(r.rows[0]!.token, 'миграция затёрла старую строку').toBe('СТАРЫЙ-ОТКРЫТЫЙ-ТОКЕН')
    } finally {
      await pg.close()
    }
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
