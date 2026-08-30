import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Absolute path to the ESM build of the drizzle migrator.
 *
 * `require.resolve` отдаёт CJS-вариант, а `.output/server` работает в ESM — оттуда
 * нужен соседний `.js`. Проверяем существование явно: если раскладка пакета изменится,
 * пусть сборка падает здесь, а не образ уезжает на прод без мигратора.
 */
function resolveDrizzleMigrator(): string {
  const esm = require.resolve('drizzle-orm/postgres-js/migrator').replace(/\.cjs$/, '.js')
  if (!existsSync(esm)) {
    throw new Error(`Не найден ESM-мигратор drizzle: ${esm}`)
  }
  return esm
}

export default defineNuxtConfig({
  modules: ['@nuxt/eslint'],
  // Отключено намеренно: девтулзы просят доустановить пакет при первом запуске,
  // а нам нужен предсказуемый старт в CI и в контейнере.
  devtools: { enabled: false },

  // Гибридный рендеринг. Публичная страница анкеты — единственное, что видит внешний
  // респондент, поэтому SSR; всё остальное живёт в iframe портала и рендерится
  // на клиенте.
  //
  // Заголовков безопасности здесь намеренно нет: их ставит `server/plugins/security-headers.ts`,
  // потому что заголовки из `routeRules` обработчик ошибок Nitro перезаписывает своими.
  routeRules: {
    '/s/**': { ssr: true },
    '/**': { ssr: false },
  },
  compatibilityDate: '2026-08-30',

  nitro: {
    // Явный пресет: в контейнере запускается .output/server/index.mjs.
    preset: 'node-server',
    externals: {
      // Nitro кладёт в сборку только то, что видит из кода сервера, а мигратор оттуда
      // не импортируется. Без этой строки миграции нечем накатить внутри образа —
      // и приходится городить второй образ ради одной команды.
      traceInclude: [resolveDrizzleMigrator()],
    },
  },

  typescript: {
    strict: true,
    // Юнит-тесты и корневые конфиги не попадают ни в один из проектов, которые Nuxt
    // генерирует сам. Без этого `pnpm typecheck` их просто не видит, а зелёная проверка,
    // которая половину дерева не читает, хуже отсутствующей.
    nodeTsConfig: {
      include: ['../tests/unit/**/*', '../vitest.config.ts', '../drizzle.config.ts'],
    },
  },

  eslint: {
    // Стилевые правила включены, чтобы не тащить в проект второй инструмент ради
    // форматирования: `eslint --fix` делает то же, что сделал бы prettier.
    config: { stylistic: true },
  },
})
