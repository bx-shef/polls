/**
 * Test file patterns, shared by the vitest config and the guard that checks them.
 *
 * Вынесено отдельно, потому что списки нужны в двух местах: конфигурации `vitest`
 * и тесту, который следит, чтобы ни один файл не остался вне обоих проектов.
 * Опечатка в пути каталога иначе не видна вообще — прогон отчитается «всё зелёное»,
 * просто не запустив половину тестов.
 */
export const TEST_INCLUDES = {
  unit: 'tests/unit/**/*.test.ts',
  nuxt: 'tests/nuxt/**/*.test.ts',
} as const
