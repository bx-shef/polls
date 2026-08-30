import { execFile } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

/**
 * Проверяем скрипт запуском, а не импортом функции: в CI выполняется именно команда,
 * и падать она должна кодом возврата, а не тихо печатать в консоль.
 */
const run = promisify(execFile)

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const baitRoot = fileURLToPath(new URL('../fixtures/layer-boundary', import.meta.url))
const script = fileURLToPath(new URL('../../scripts/check-layer-boundaries.mjs', import.meta.url))

interface FailedRun { code?: number, stderr?: string }

describe('граница слоёв: app/ не импортирует server/', () => {
  it('на настоящем дереве проекта проходит', async () => {
    const { stdout } = await run(process.execPath, [script, repoRoot])

    expect(stdout).toContain('цела')
  })

  // Приманка: без неё «проверка зелёная» ничего не доказывает — сломанный скрипт,
  // который молча ничего не находит, выглядит ровно так же, как работающий.
  it('на приманке падает и называет каждый способ протащить импорт', async () => {
    const failure: FailedRun = await run(process.execPath, [script, baitRoot]).then(
      () => ({}),
      (error: FailedRun) => error,
    )
    const stderr = failure.stderr ?? ''

    expect(failure.code).toBe(1)
    // псевдоним корня, относительный путь, динамический import()
    expect(stderr).toContain('app/pages/alias-import.vue')
    expect(stderr).toContain('app/composables/relative-import.ts')
    expect(stderr).toContain('app/composables/dynamic-import.ts')
    // обратные кавычки — гейт их однажды не видел
    expect(stderr).toContain('app/composables/backtick-import.ts')
    // shared/ уезжает на клиент наравне с app/
    expect(stderr).toContain('shared/from-shared.ts')
  })
})
