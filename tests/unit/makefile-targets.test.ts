import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Гвард под дефект, из-за которого `Makefile` не выдавался на сервер.
 *
 * Он жёстко искал `deploy/compose.yaml`, которого на сервере нет: там лежат плоские
 * `compose.yaml`, `Makefile` и `.env`. Любая цель падала с «No rule to make target» —
 * сообщением, которое GNU make выдаёт, когда makefile не найден вовсе, то есть уводящим
 * от настоящей причины.
 *
 * Проверяем ровно две развилки, на которых это ломается, и обе — запуском настоящего
 * make. Docker и сеть не нужны: разбор целей идёт через `make -n`, а отказ цели
 * разработки срабатывает на первой же строке рецепта, до любого `docker`.
 */

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const MAKEFILE = join(REPO, 'Makefile')

const temps: string[] = []

/** Каталог с `Makefile` и заданной раскладкой compose-файлов. */
function layout(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'polls-make-'))
  temps.push(dir)
  cpSync(MAKEFILE, join(dir, 'Makefile'))
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), 'services: {}\n')
  }
  return dir
}

function make(dir: string, args: string[]): { out: string, code: number } {
  try {
    return { out: execFileSync('make', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), code: 0 }
  }
  catch (e) {
    const err = e as { status?: number, stdout?: string, stderr?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? -1 }
  }
}

afterAll(() => {
  for (const dir of temps) execFileSync('rm', ['-rf', dir])
})

describe('выбор compose-файла', () => {
  it('на сервере берёт плоский compose.yaml рядом с собой', () => {
    const { out, code } = make(layout(['compose.yaml']), ['-n', 'prod-ps'])

    expect(code).toBe(0)
    expect(out).toContain('docker compose -f compose.yaml ps')
  })

  it('в репозитории берёт deploy/compose.yaml, а не корневой стек разработки', () => {
    // Корневой compose.yaml — это база и Redis для разработки. Прод-цель, взявшая его,
    // подняла бы не то, и заметно это стало бы только по отсутствию приложения.
    const { out, code } = make(layout(['compose.yaml', 'deploy/compose.yaml']), ['-n', 'prod-ps'])

    expect(code).toBe(0)
    expect(out).toContain('docker compose -f deploy/compose.yaml ps')
    expect(out).not.toContain('docker compose -f compose.yaml ps')
  })

  it('без compose-файла объясняет причину, а не молчит про make target', () => {
    const { out, code } = make(layout([]), ['prod-up'])

    expect(code).not.toBe(0)
    expect(out).toContain('compose.yaml')
    expect(out).toContain('host-update')
  })
})

describe('.env берётся из каталога compose-файла', () => {
  // Compose читает `.env` не из текущего каталога, а из каталога compose-файла —
  // проверено запросом `docker compose config` с двумя разными `.env`. Прочитай
  // диагностика не тот файл, она сообщила бы «DOMAIN не задан» при заданном DOMAIN.
  it('на сервере — ./.env', () => {
    const { out } = make(layout(['compose.yaml']), ['-n', 'doctor'])

    expect(out).toContain('./.env')
    expect(out).not.toContain('deploy/.env')
  })

  it('в репозитории — deploy/.env', () => {
    const { out } = make(layout(['compose.yaml', 'deploy/compose.yaml']), ['-n', 'doctor'])

    expect(out).toContain('deploy/.env')
  })
})

describe('цели разработки на сервере', () => {
  // `compose.yaml` на сервере — прод-стек, поэтому `make down` там погасил бы боевое
  // приложение вместо локальной базы. Отказ срабатывает до первого вызова docker.
  it.each(['up', 'down', 'dev', 'check', 'image'])('%s отказывается работать без исходников', (target) => {
    const { out, code } = make(layout(['compose.yaml']), [target])

    expect(code).not.toBe(0)
    expect(out).toContain('только в репозитории')
    expect(out).not.toContain('docker compose -f compose.yaml')
  })

  it('в репозитории та же цель доходит до дела', () => {
    const dir = layout(['compose.yaml'])
    writeFileSync(join(dir, 'package.json'), '{}\n')

    const { out, code } = make(dir, ['-n', 'up'])

    expect(code).toBe(0)
    expect(out).toContain('docker compose -f compose.yaml up -d')
  })
})
