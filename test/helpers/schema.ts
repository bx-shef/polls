import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Каталог миграций — ЕДИНЫЙ источник схемы и для node-pg-migrate (прод гоняет эти
// же .sql на Postgres, #6), и для pglite-тестов (здесь, in-process WASM-Postgres).
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))

// up-секция .sql-миграции — ТОЧНОЕ зеркало node-pg-migrate (sqlMigration.getActions):
// есть «-- Up Migration» → от него до «-- Down Migration» (или до конца файла);
// нет up-маркера → ВЕСЬ файл (как и node-pg-migrate), чтобы тест применял ту же
// схему, что прод (даже при «битом» файле с одним лишь down-маркером).
export function upSql(content: string): string {
  const up = content.search(/^\s*--[\s-]*up\s+migration/im)
  const down = content.search(/^\s*--[\s-]*down\s+migration/im)
  if (up >= 0) return content.slice(up, down > up ? down : undefined)
  return content
}

/** SQL всех миграций по порядку имени файла (0001_, 0002_, …). */
export function migrationSqls(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => upSql(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
}

/** Минимальная цель применения схемы — у PGlite есть `exec` для мультистейтмента. */
export interface SchemaTarget {
  exec(sql: string): Promise<unknown>
}

/** Применяет миграции `migrations/*.sql` по порядку (для pglite-тестов). */
export async function applySchema(target: SchemaTarget): Promise<void> {
  for (const sql of migrationSqls()) await target.exec(sql)
}
