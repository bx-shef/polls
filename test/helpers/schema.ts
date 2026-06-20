import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// upSql — ЕДИНЫЙ с прод-boot-применением (src/store/migrate), чтобы тест применял ту же схему.
import { upSql } from '../../src/store/migrate'

export { upSql }

// Каталог миграций — ЕДИНЫЙ источник схемы и для node-pg-migrate (прод гоняет эти
// же .sql на Postgres, #6), и для pglite-тестов (здесь, in-process WASM-Postgres).
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))

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
