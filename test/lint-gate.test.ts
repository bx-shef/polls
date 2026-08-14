import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Линт-гейт проверяется ИСПОЛНЕНИЕМ: запускаем настоящий ESLint на файле-приманке и смотрим, какие
 * правила он назвал.
 *
 * ⚠️ Почему не грепом по `eslint.config.mjs`. В этом проекте гарды, сверявшие ТЕКСТ конфигурации, а не
 * её поведение, проваливались трижды (#153, #159, #162): подстроку удовлетворяет и комментарий, и
 * объявление выше настоящего, и правило, выключенное ниже по цепочке конфигов. Здесь та же ловушка
 * особенно вероятна: типовые правила молча вырождаются в ничто, если файл не попал ни в один проект
 * TypeScript, — конфиг при этом выглядит правильным, а линт печатает «0 problems».
 *
 * Приманка (`fixtures/floating-promise.fixture.ts`) исключена из обычного `pnpm lint`, иначе валила бы
 * гейт всегда; снимаем исключение `--no-ignore`.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const runEslint = (target: string) => spawnSync(
  'npx',
  ['--no-install', 'eslint', '--no-ignore', '--format', 'json', target],
  { cwd: ROOT, encoding: 'utf8', timeout: 180_000 }
)

interface EslintMessage { ruleId: string | null }
interface EslintResult { messages: EslintMessage[] }

describe('линт-гейт забытого await (#165)', () => {
  const report = (() => {
    const r = runEslint('test/fixtures/floating-promise.fixture.ts')
    // ESLint отдаёт 1 при найденных ошибках и 2 при собственном сбое (не читается конфиг, нет
    // плагина). Различаем, иначе сбой инструмента читался бы как «правила не сработали».
    // ⚠️ Файл вне проекта TypeScript даёт как раз 1, а не 2 — сообщением с `ruleId: null`;
    // от этого случая защищают проверки состава правил ниже, а не код возврата.
    expect(r.error, `ESLint не запустился: ${String(r.error)}`).toBeUndefined()
    expect(r.status, `ESLint не смог отработать:\n${r.stderr}`).not.toBe(2)
    return JSON.parse(r.stdout) as EslintResult[]
  })()

  const rules = new Set(report.flatMap((f) => f.messages.map((m) => m.ruleId)))

  it('ловит промис, чей результат отброшен', () => {
    // Форма, которую `tsc` пропускает молча: с реализацией на БД это unhandled rejection, а на Node
    // это падение процесса — то есть телеметрия/стор роняют сервис, который обслуживают.
    expect(rules, `правила сработали: ${[...rules].join(', ') || '(ни одного)'}`)
      .toContain('@typescript-eslint/no-floating-promises')
  })

  it('ловит промис в булевом контексте — включая ОТРИЦАТЕЛЬНЫЙ гард', () => {
    // `if (!inv) return 403` на промисе всегда ложно. Для `peek` это значит, что «ссылка
    // недействительна» не сработает никогда, а CRM-снимок уйдёт наружу для любого токена.
    expect(rules).toContain('@typescript-eslint/no-misused-promises')
  })

  it('ловит await на не-промисе', () => {
    expect(rules).toContain('@typescript-eslint/await-thenable')
  })

  it('на боевом коде гейт ЗЕЛЁНЫЙ — иначе он не гейт, а шум', () => {
    // Проверяем сам предмет защиты: `src/api/invitation.ts` — порт, ради которого правила заводились.
    const r = runEslint('src/api/invitation.ts')
    expect(r.status, `боевой файл не проходит линт:\n${r.stdout}\n${r.stderr}`).toBe(0)
  })
})

/**
 * Покрытие КАЖДОЙ области — отдельно и пробой.
 *
 * ⚠️ Без этого блока гард был уже, чем обещал, и ревью показало это исполнением: если убрать из
 * `eslint.config.mjs` область `server/**`, то `pnpm lint` печатает пустой вывод и возвращает 0 даже
 * при настоящем висячем промисе в `server/` — файл просто не попадает ни под одну конфигурацию
 * («ignored because no matching configuration was supplied»). Тесты выше при этом оставались
 * зелёными: они линтуют приманку и один файл из `src/`. То есть «половина серверного кода не
 * проверяется» — сценарий, названный в доках закрытым, — не ловился ничем.
 *
 * Проба пишется в саму область (иначе она не попадёт под её glob), линтуется и удаляется в `finally`.
 * Имя внесено в `.gitignore` на случай, если прогон упадёт между записью и удалением.
 */
describe('типовые правила работают в КАЖДОЙ области, а не только в src/', () => {
  const PROBE = `
interface Probe { save(v: string): Promise<void> }
export function probe(p: Probe): void {
  p.save('проба')
}
`
  const areas: Array<[name: string, dir: string]> = [
    ['src/', 'src'],
    ['server/', 'server/utils'],
    ['app/', 'app/utils'],
    ['test/', 'test'],
    ['scripts/', 'scripts']
  ]

  it.each(areas)('%s — висячий промис пойман', (_name, dir) => {
    const rel = `${dir}/__lint-probe.ts`
    const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url))
    try {
      writeFileSync(abs, PROBE)
      const r = runEslint(rel)
      // status 2 — сбой самого ESLint (например, `project` указывает в несуществующий файл);
      // status 0 — область выпала из конфигурации, и это ТИХИЙ пропуск, ради которого блок и написан.
      expect(r.error, `ESLint не запустился: ${String(r.error)}`).toBeUndefined()
      expect(r.status, `ESLint сломался на ${rel}:\n${r.stderr}`).not.toBe(2)
      const rules = JSON.parse(r.stdout || '[]')
        .flatMap((f: EslintResult) => f.messages.map((m) => m.ruleId))
      expect(rules, `область ${dir} не покрыта типовыми правилами (вывод: ${r.stdout || '(пусто)'})`)
        .toContain('@typescript-eslint/no-floating-promises')
    } finally {
      rmSync(abs, { force: true })
    }
  })

  it('.vue — висячий промис пойман', () => {
    // Отдельно от `.ts`: у `.vue` свой блок конфигурации со своим парсером, и его удаление тестами
    // выше не ловится. Ревью показало исполнением: без него все 13 компонентов выпадают беззвучно.
    const rel = 'app/components/__lint-probe.vue'
    const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url))
    try {
      writeFileSync(abs, `<script setup lang="ts">\nasync function probe(): Promise<void> {}\nprobe()\n</script>\n`)
      const r = runEslint(rel)
      expect(r.error, `ESLint не запустился: ${String(r.error)}`).toBeUndefined()
      const rules = JSON.parse(r.stdout || '[]')
        .flatMap((f: EslintResult) => f.messages.map((m) => m.ruleId))
      expect(rules, `.vue не покрыт (вывод: ${r.stdout || '(пусто)'})`)
        .toContain('@typescript-eslint/no-floating-promises')
    } finally {
      rmSync(abs, { force: true })
    }
  })
})

/**
 * Fail-closed: КАЖДЫЙ исходник на диске обязан попасть под конфигурацию с нашими правилами.
 *
 * ⚠️ Проверки выше перечисляют области руками — и потому ловят только те, о которых уже знают. Тихий
 * режим отказа у ESLint ровно один и он не про правила: файл, не совпавший ни с одним `files`,
 * пропускается **без слова и с кодом 0**. Так выпадут `shared/**` (штатная конвенция Nuxt 4, конфиг
 * под неё уже генерируется), новое расширение (`.mts`), новый каталог верхнего уровня. Ревью показало
 * это исполнением: висячий промис в `shared/` даёт `eslint .` → exit 0, пустой вывод.
 *
 * Поэтому сверяем СПИСКИ: что лежит на диске против того, для чего ESLint резолвит правила. Список
 * известных исключений держим здесь же — он обязан быть коротким и видимым, а не растворяться в
 * `ignores`.
 */
describe('ни один исходник не выпадает из линта молча', () => {
  it('для каждого файла ESLint резолвит наши правила', async () => {
    const { ESLint } = await import('eslint')
    const eslint = new ESLint({ cwd: ROOT })

    const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output', '.git', 'coverage',
      'dist', 'test-results', 'reporting-kit', '__screenshots__'])
    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full)
        } else if (/\.(ts|mts|cts|vue|mjs)$/.test(entry.name)) {
          sources.push(relative(ROOT, full))
        }
      }
    }
    walk(ROOT)
    expect(sources.length, 'обход не нашёл исходников — проверка выродилась').toBeGreaterThan(100)

    // Приманка нарушает правила намеренно и живёт в `ignores`; остального в списке быть не должно.
    const KNOWN_UNCOVERED = new Set(['test/fixtures/floating-promise.fixture.ts'])

    const uncovered: string[] = []
    for (const file of sources) {
      if (KNOWN_UNCOVERED.has(file)) continue
      const config = await eslint.calculateConfigForFile(file)
      if (!config?.rules?.['@typescript-eslint/no-floating-promises']) uncovered.push(file)
    }
    expect(uncovered, `эти файлы линт пропускает МОЛЧА:\n${uncovered.join('\n')}`).toEqual([])
  })

  /**
   * ⚠️ Мало проверить, что правило «есть»: его можно ослабить ОПЦИЯМИ, и приманка этого не заметит.
   * Ревью показало мутантом: `no-misused-promises` с `checksVoidReturn: false` оставлял гард зелёным,
   * теряя ровно ту способность, которую комментарий рядом обещает — async-колбэк там, где ждут
   * синхронный. То же для `ignoreVoid`/`ignoreIIFE` у `no-floating-promises`. Поэтому пиннем
   * СОСТОЯНИЕ каждого правила у представителя каждой области, а не факт упоминания.
   */
  it('у представителя каждой области все правила в состоянии error и без ослабляющих опций', async () => {
    const { ESLint } = await import('eslint')
    const eslint = new ESLint({ cwd: ROOT })
    const REQUIRED = ['@typescript-eslint/no-floating-promises', '@typescript-eslint/await-thenable',
      '@typescript-eslint/no-misused-promises', 'no-control-regex']
    const WEAKENING = new Set(['checksVoidReturn', 'checksConditionals', 'checksSpreads',
      'ignoreVoid', 'ignoreIIFE'])

    for (const file of ['src/api/invitation.ts', 'server/utils/portal.ts', 'app/utils/landing.ts',
      'app/app.vue', 'test/api.test.ts', 'scripts/verify.ts', 'otel.instrument.mjs']) {
      const config = await eslint.calculateConfigForFile(file)
      // Без типов правила промисов не работают вовсе — а конфиг при этом выглядит настроенным.
      expect(config?.languageOptions?.parserOptions?.project, `${file}: нет привязки к проекту TypeScript`)
        .toBeTruthy()
      for (const rule of REQUIRED) {
        // `calculateConfigForFile` отдаёт уровень числом (2 = error), а не строкой.
        const entry = config?.rules?.[rule] as [number | string, Record<string, unknown>?] | undefined
        expect([2, 'error'], `${file}: правило ${rule} не в состоянии error (${String(entry?.[0])})`)
          .toContain(entry?.[0])
        for (const opt of Object.keys(entry?.[1] ?? {})) {
          expect(WEAKENING.has(opt) && entry?.[1]?.[opt] === false,
            `${file}: ${rule} ослаблено опцией ${opt}: false`).toBe(false)
        }
      }
    }
  })
})

/**
 * Проводка гейта. Здесь греп УМЕСТЕН — вопрос не про поведение правил, а про то, зовут ли линт вообще.
 * Ревью показало двумя мутантами: `"lint": "eslint src"` и удаление шага из `pnpm check`/CI оставляли
 * все проверки выше зелёными, потому что они запускают ESLint сами и о проводке ничего не знают.
 */
describe('гейт действительно подключён, а не просто настроен', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8')

  it('pnpm check и CI зовут линт, и линт смотрит на весь проект', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.check, '`pnpm check` не зовёт линт').toContain('pnpm lint')
    // `eslint src` вместо `eslint .` — рабочий способ выключить линт для server/ и app/, не тронув конфиг.
    expect(pkg.scripts.lint, 'линт смотрит не на весь проект').toMatch(/eslint \.(\s|$)/)
    // Без `--max-warnings=0` любое предупреждение (в т.ч. мёртвое подавление) не роняет CI.
    expect(pkg.scripts.lint, 'предупреждения не гейтятся').toContain('--max-warnings=0')
    expect(read('.github/workflows/ci.yml'), 'в CI нет шага линта').toMatch(/run:\s*pnpm lint/)
    expect(read('scripts/check.sh'), 'локальная проверка расходится с гейтом мержа').toMatch(/pnpm -s lint/)
    expect(read('scripts/check.ps1'), 'локальная проверка расходится с гейтом мержа').toMatch(/pnpm -s lint/)
  })

  it('в исходниках нет подавления линта целым файлом', () => {
    // `/* eslint-disable */` без имён правил глушит файл целиком и не даёт даже предупреждения —
    // штатный способ «починить» красный линт одной строкой. Точечные подавления с именем правила
    // остаются разрешёнными: они видны в диффе и объясняются рядом.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|mts|cts|vue|mjs)$/.test(entry.name)) {
          // Себя пропускаем: сам шаблон поиска — литерал в этом файле, иначе гард ловит собственный текст.
          if (full === fileURLToPath(import.meta.url)) continue
          const text = readFileSync(full, 'utf8')
          if (/\/\*\s*eslint-disable\s*\*\//.test(text)) offenders.push(relative(ROOT, full))
        }
      }
    }
    for (const dir of ['src', 'server', 'app', 'test', 'scripts']) {
      walk(fileURLToPath(new URL(`../${dir}`, import.meta.url)))
    }
    expect(offenders, `линт заглушён целиком в:\n${offenders.join('\n')}`).toEqual([])
  })
})
