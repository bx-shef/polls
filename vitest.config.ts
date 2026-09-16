import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'
import { TEST_INCLUDES } from './tests/includes.ts'

/**
 * Три проекта, потому что у нас три разных мира.
 *
 * `unit` — чистые функции и серверные модули в обычном Node: быстро, без Nuxt.
 * `nuxt` — компоненты в окружении Nuxt: дорого, поэтому здесь только то, что без него
 * проверить нельзя.
 * `db` — то, что проверяется ТОЛЬКО настоящим Postgres: блокировки строк и условия,
 * которых нет ни в одном моке. Без `DATABASE_URL` эти файлы пропускают себя сами.
 *
 * ⚠ Третий проект появился по следам дефекта, который юнит-тест поймать не мог
 * в принципе: `requeueStuck` сравнивал не ту колонку и забирал строку, которую только
 * что взяли в работу, — то есть отправлял бы ответ в портал дважды. Подделка базы
 * такое не ловит: ловит только база. Нашла панель ревью PR #22.
 *
 * Пути живут в `tests/includes.ts`: их же читает гвард, следящий, чтобы новый файл
 * теста не оказался вне всех проектов.
 */
export default defineConfig(async () => ({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [TEST_INCLUDES.unit],
        },
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: [TEST_INCLUDES.db],
          // Блокировки проверяются параллельными запросами к одной таблице —
          // разные файлы, идущие одновременно, мешали бы друг другу.
          fileParallelism: false,
        },
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          environment: 'nuxt',
          include: [TEST_INCLUDES.nuxt],
          // Окружение Nuxt поднимается небыстро — таймаут по умолчанию здесь мал.
          testTimeout: 30_000,
        },
      }),
    ],
  },
}))
