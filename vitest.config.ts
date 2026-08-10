import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Тот же алиас, что у Nuxt (`~core → src/`). Нужен, чтобы тесты могли загрузить файлы из `server/`:
  // без него `server/middleware/body-limit.ts` в vitest не резолвится, и единственной проверкой
  // бэкстопа остаётся греп по исходнику — а он не ловит даже полностью выключенную защиту.
  resolve: {
    alias: { '~core': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/store/**', 'src/api/**', 'src/server/**', 'src/bitrix24/**', 'src/obs/**', 'src/client/**',
        // Бутстрап телеметрии — прод-путь, и порог покрытия обязан его видеть: он лежит в корне,
        // а не в src/, и без явного включения выпадал из отчёта целиком.
        'otel.instrument.mjs'],
      exclude: ['src/demo/**', 'src/index.ts', 'src/store/types.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 85
      }
    }
  }
})
