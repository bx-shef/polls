import type { Queryable } from './types'

/**
 * Применение миграций на старте инстанса (ISSUE #6). Каталог `migrations/*.sql` — ЕДИНЫЙ
 * источник схемы и для node-pg-migrate (CLI), и для pglite-тестов, и для boot-применения здесь.
 * Миграции идемпотентны (`create ... if not exists`), поэтому повторный прогон безопасен —
 * для single-instance этого достаточно; координация миграций мульти-инстанса — слой #4.
 */

/**
 * up-секция .sql-миграции — ТОЧНОЕ зеркало node-pg-migrate (sqlMigration.getActions):
 * есть «-- Up Migration» → от него до «-- Down Migration» (или до конца файла);
 * нет up-маркера → ВЕСЬ файл (как и node-pg-migrate).
 */
export function upSql(content: string): string {
  const up = content.search(/^\s*--[\s-]*up\s+migration/im)
  const down = content.search(/^\s*--[\s-]*down\s+migration/im)
  if (up >= 0) return content.slice(up, down > up ? down : undefined)
  return content
}

/**
 * Применяет up-SQL миграций по порядку через `Queryable.query` (pg.Pool — простой протокол,
 * мультистейтмент в одном вызове). Идемпотентны → повторный boot не падает.
 */
export async function applyMigrations(db: Queryable, sqls: string[]): Promise<void> {
  for (const sql of sqls) await db.query(sql)
}
