import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

function make(dir: string, args: string[], env: Record<string, string> = {}): { out: string, code: number } {
  try {
    return {
      out: execFileSync('make', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }),
      code: 0,
    }
  }
  catch (e) {
    const err = e as { status?: number, stdout?: string, stderr?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? -1 }
  }
}

/**
 * Каталог с `Makefile` и ПОДСТАВНЫМ `docker` в `PATH`.
 *
 * ⚠ Нужен там, где `make -n` бессилен. Цель с ветвлением внутри рецепта печатается
 * при `-n` целиком, вместе с обеими ветками, — то есть по её выводу НЕЛЬЗЯ сказать,
 * какая из них сработала бы. А именно это здесь и надо проверить: без `APPLY` цель
 * обязана только смотреть. Поэтому цель выполняется по-настоящему, а наружу вместо
 * `docker` встаёт `echo`.
 */
function withFakeDocker(files: string[]): { dir: string, env: Record<string, string> } {
  const dir = layout(files)
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "docker $@"\n')
  execFileSync('chmod', ['+x', join(bin, 'docker')])
  return { dir, env: { PATH: `${bin}:${process.env.PATH ?? ''}` } }
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

/**
 * Гвард под дефект, найденный на живом хосте.
 *
 * `doctor` искал контейнеры прокси по всей строке `имя образ` и по шаблону `nginxproxy`.
 * На хосте контейнер `acme-companion` называется `letsencrypt`, а его образ —
 * `nginxproxy/acme-companion`: под оба шаблона он подошёл, и диагностика объявила его
 * и прокси, и acme одновременно. Дальше она искала vhost и сертификат внутри не того
 * контейнера и выдавала два ложных «ПЛОХО» при исправном прокси.
 *
 * Шаблоны берутся из самого `Makefile`, иначе тест проверял бы копию, а не код.
 */
describe('поиск прокси и acme среди контейнеров хоста', () => {
  const makefile = readFileSync(MAKEFILE, 'utf8')

  /** Вытащить awk-программу из строки вида `<имя>=$(docker ps … | awk -F'\t' '<программа>')`. */
  function program(varName: string): string {
    const line = makefile.split('\n').find(l => l.includes(`${varName}=$$(docker ps`))
    expect(line, `в Makefile нет строки ${varName}=…`).toBeDefined()
    const match = line!.match(/awk -F'\\t' '(.+?)'\)/)
    expect(match, `в строке ${varName} не нашлась awk-программа`).not.toBeNull()
    // В Makefile `$$` — это экранированный для make доллар; шеллу достаётся один.
    return match![1]!.replaceAll('$$', '$')
  }

  /** Прогнать программу по строкам `имя<TAB>образ`, как их отдаёт `docker ps`. */
  function pick(varName: string, rows: string[]): string {
    const out = execFileSync('awk', ['-F', '\t', program(varName)], {
      input: `${rows.join('\n')}\n`,
      encoding: 'utf8',
    })
    return out.trim()
  }

  // Ровно та раскладка, что на хосте: имя контейнера ничего не говорит о его роли.
  const HOST = [
    'letsencrypt\tnginxproxy/acme-companion:2.6',
    'webproxy\tnginxproxy/nginx-proxy:1.7',
    'polls\tghcr.io/bx-shef/polls:latest',
  ]

  it('находит прокси по образу, а не по имени контейнера', () => {
    expect(pick('proxy', HOST)).toBe('webproxy')
  })

  it('не принимает acme-companion за прокси', () => {
    // Это и был дефект: без контейнера прокси диагностика всё равно «находила» его.
    expect(pick('proxy', [HOST[0]!])).toBe('')
  })

  it('находит acme отдельно от прокси', () => {
    expect(pick('acme', HOST)).toBe('letsencrypt')
  })

  it('знает и старый образ companion, не путая его с прокси', () => {
    // `jrcs/letsencrypt-nginx-proxy-companion` содержит «nginx-proxy» в имени образа.
    const old = ['le\tjrcs/letsencrypt-nginx-proxy-companion:v1.13']

    expect(pick('proxy', old)).toBe('')
    expect(pick('acme', old)).toBe('le')
  })
})

/**
 * Гварды под issue #24: разбор застрявших ответов.
 *
 * Цена ошибки несимметрична. Не показали застрявшую строку — ответ живого человека лежит
 * в Postgres неопределённо долго, а единственный сигнал о нём это растущее число
 * в счётчике здоровья. Записали, когда просили посмотреть, — тронули чужие данные без
 * ведома оператора.
 */
describe('разбор застрявших ответов', () => {
  it('повтор БЕЗ APPLY ничего не меняет, а только показывает', () => {
    // ⚠ ГЛАВНЫЙ ГВАРД. `make -n` здесь не годится: он печатает обе ветки рецепта,
    // и по его выводу нельзя сказать, какая сработала бы. Поэтому цель выполняется
    // по-настоящему, с подставным `docker`.
    const { dir, env } = withFakeDocker(['compose.yaml'])

    const { out, code } = make(dir, ['prod-retry'], env)

    expect(code).toBe(0)
    expect(out).toContain('СУХОЙ ПРОГОН')
    expect(out).toContain('select')
    expect(out).not.toContain('update inbox')
  })

  it('повтор с APPLY=1 действительно возвращает строки в pending', () => {
    const { dir, env } = withFakeDocker(['compose.yaml'])

    const { out } = make(dir, ['prod-retry', 'APPLY=1'], env)

    expect(out).toContain('update inbox')
    expect(out).toContain(`status = 'pending'`)
  })

  it('повтор СБРАСЫВАЕТ счётчик попыток и срок', () => {
    // ⚠ Без сброса цель была бы пустышкой: строка попала в `failed`, исчерпав предел
    // попыток, и вернувшись в `pending` с прежним счётчиком упёрлась бы в тот же предел
    // на первой же попытке. Внешне — «повторил, не помогло».
    const { dir, env } = withFakeDocker(['compose.yaml'])

    const { out } = make(dir, ['prod-retry', 'APPLY=1'], env)

    expect(out).toContain('attempts = 0')
    expect(out).toContain('next_attempt_at = now()')
  })

  it('повтор сужается по домену портала и по строке', () => {
    // Почти все причины чинятся на стороне КОНКРЕТНОГО портала, поэтому пачка по домену —
    // основной случай; отдельная строка нужна, когда чинили точечно.
    const { dir, env } = withFakeDocker(['compose.yaml'])

    expect(make(dir, ['prod-retry', 'DOMAIN=x.bitrix24.ru'], env).out).toContain(`p.domain = 'x.bitrix24.ru'`)
    expect(make(dir, ['prod-retry', 'ID=00000000-0000-0000-0000-000000000001'], env).out)
      .toContain(`i.id = '00000000-0000-0000-0000-000000000001'`)
  })

  it('повтор трогает ТОЛЬКО failed, даже когда отбора нет', () => {
    // ⚠ Без этого условия цель, запущенная без DOMAIN и ID, вернула бы в очередь и то,
    // что воркер держит прямо сейчас (`sending`), — то есть доставила бы ответ дважды.
    const { dir, env } = withFakeDocker(['compose.yaml'])

    expect(make(dir, ['prod-retry', 'APPLY=1'], env).out).toContain(`i.status = 'failed'`)
  })

  it('показ застрявших называет портал и не показывает ответ', () => {
    // ⚠ Без домена строка отвечает «что-то не доставилось» и не отвечает «кому», а чинится
    // это почти всегда на стороне конкретного портала. `payload` при этом не показывается
    // и показан не будет: в нём ответ живого человека.
    const { dir, env } = withFakeDocker(['compose.yaml'])

    const { out, code } = make(dir, ['prod-stuck'], env)

    expect(code).toBe(0)
    expect(out).toContain('p.domain')
    expect(out).toContain(`i.status = 'failed'`)
    expect(out).not.toContain('payload')
  })

  it('показ застрявших не режется по числу строк', () => {
    // ⚠ Гвард под причину, по которой цель заведена отдельно от `prod-inbox`: тот показывает
    // первые двадцать по времени, и всплеск свежих `pending` прячет `failed` за край выдачи
    // ровно тогда, когда буфер и так не в порядке.
    const { dir, env } = withFakeDocker(['compose.yaml'])

    expect(make(dir, ['prod-stuck'], env).out).not.toContain('limit')
  })
})
