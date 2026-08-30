import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'
import { TEST_INCLUDES } from './tests/includes.ts'

/**
 * Два проекта, потому что у нас два разных мира.
 *
 * `unit` — чистые функции и серверные модули в обычном Node: быстро, без Nuxt.
 * `nuxt` — компоненты в окружении Nuxt: дорого, поэтому здесь только то, что без него
 * проверить нельзя.
 *
 * Пути живут в `tests/includes.ts`: их же читает гвард, следящий, чтобы новый файл
 * теста не оказался вне обоих проектов.
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
