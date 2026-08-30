import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TEST_INCLUDES } from '../includes'

/**
 * Гвард: файл теста, попавший мимо обоих проектов `vitest`, не запускается — и прогон
 * при этом отчитывается «всё зелёное». Проверено вживую: `tests/stray/oops.test.ts`
 * с заведомо падающим утверждением был просто проигнорирован.
 *
 * Здесь мы сверяем реальное дерево с тем, что описано в `tests/includes.ts`.
 */
const testsDir = fileURLToPath(new URL('..', import.meta.url))

/** Каталог с намеренно сломанными файлами — он и не должен попадать ни в один проект. */
const EXCLUDED = ['fixtures']

function findTestFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      return EXCLUDED.includes(entry) ? [] : findTestFiles(full)
    }
    return entry.endsWith('.test.ts') ? [full] : []
  })
}

/** Превращает glob вида `tests/unit/**` в проверку принадлежности каталогу. */
function directoryOf(pattern: string): string {
  return pattern.replace(/\/\*\*.*$/, '').replace(/^tests\//, '')
}

describe('все тесты попадают в один из проектов vitest', () => {
  const projectDirs = Object.values(TEST_INCLUDES).map(directoryOf)

  it('ни один файл теста не остался вне проектов', () => {
    const orphans = findTestFiles(testsDir)
      .map(file => relative(testsDir, file))
      .filter(file => !projectDirs.some(dir => file.startsWith(`${dir}/`)))

    expect(orphans).toEqual([])
  })

  it('каталоги проектов существуют и не пусты', () => {
    for (const dir of projectDirs) {
      expect(findTestFiles(join(testsDir, dir)).length, `в tests/${dir} нет тестов`).toBeGreaterThan(0)
    }
  })
})
