#!/usr/bin/env node
/**
 * Applies pending migrations.
 *
 * Запускается и из репозитория (`pnpm db:migrate`), и внутри образа одноразовым
 * запуском того же контейнера — поэтому папка с миграциями задаётся переменной,
 * а не выводится из рабочего каталога.
 */
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL не задан — накатывать миграции некуда.')
  process.exit(1)
}

const migrationsFolder = process.env.MIGRATIONS_DIR
  ?? fileURLToPath(new URL('../server/db/migrations', import.meta.url))

// max: 1 — миграции идут последовательно, пул здесь только мешает.
const sql = postgres(url, { max: 1, onnotice: () => {} })

try {
  await migrate(drizzle(sql), { migrationsFolder })
  console.log(`Миграции накачены из ${migrationsFolder}.`)
}
finally {
  await sql.end()
}
