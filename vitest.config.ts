import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'

/**
 * Два проекта, потому что у нас два разных мира.
 *
 * `unit` — чистые функции и серверные модули в обычном Node: быстро, без Nuxt.
 * `nuxt` — компоненты в окружении Nuxt: дорого, поэтому здесь только то, что без него
 * проверить нельзя.
 */
export default defineConfig(async () => ({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          environment: 'nuxt',
          include: ['tests/nuxt/**/*.test.ts'],
          // Окружение Nuxt поднимается небыстро — таймаут по умолчанию здесь мал.
          testTimeout: 30_000,
        },
      }),
    ],
  },
}))
