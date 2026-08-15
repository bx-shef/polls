import { describe, it, expect, beforeAll } from 'vitest'
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
 * Две пробы НАСТОЯЩИМ файлом — там, где сверка резолва конфигурации (ниже) недостаточна.
 *
 * ⚠️ Проб именно две, а не по одной на каждую область. Раньше их было шесть, и они стоили 22 секунды
 * из 30 при том, что покрывали пять областей из семи — то есть самый дорогой слой защищал хуже
 * самого дешёвого. Сверка `calculateConfigForFile` по всему дереву (0,9 с) покрывает ВСЕ области
 * включая будущие, поэтому здесь остались только два случая, которые она доказать не может:
 *  - `server/` — резолв конфигурации не доказывает, что типы РЕАЛЬНО подгружаются: `project` может
 *    указывать в несуществующий файл. (Такое падает громко, но проба дешевле рассуждения.)
 *  - `.vue` — другой парсер; резолв правил ничего не говорит о том, добрались ли они до `<script>`.
 *
 * Проба пишется в саму область (иначе не попадёт под её glob) и удаляется в `finally`.
 */
describe('правила доходят до кода, а не только резолвятся', () => {
  const PROBES = ['server/utils/__lint-probe.ts', 'app/components/__lint-probe.vue']
  // Проба намеренно НЕ в `.gitignore`: остаток должен быть виден в `git status`, а не тихо лежать
  // при красном линте. Цена — прерванный прогон (SIGINT, таймаут, OOM) оставляет файл; поэтому
  // подчищаем остатки на входе, чтобы это самозаживало, а не требовало ручной уборки.
  beforeAll(() => {
    for (const rel of PROBES) rmSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), { force: true })
  })

  it('server/ — висячий промис пойман настоящим прогоном', () => {
    const rel = 'server/utils/__lint-probe.ts'
    const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url))
    try {
      writeFileSync(abs, `
interface Probe { save(v: string): Promise<void> }
export function probe(p: Probe): void {
  p.save('проба')
}
`)
      const r = runEslint(rel)
      expect(r.error, `ESLint не запустился: ${String(r.error)}`).toBeUndefined()
      expect(r.status, `ESLint сломался на ${rel}:\n${r.stderr}`).not.toBe(2)
      const rules = JSON.parse(r.stdout || '[]')
        .flatMap((f: EslintResult) => f.messages.map((m) => m.ruleId))
      expect(rules, `типы не подгружаются (вывод: ${r.stdout || '(пусто)'})`)
        .toContain('@typescript-eslint/no-floating-promises')
    } finally {
      rmSync(abs, { force: true })
    }
  })

  it('.vue — висячий промис пойман', () => {
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
/**
 * ⚠️ Список расширений ШИРЕ, чем `files` в конфиге, и это намеренно. Совпадай он — новое расширение
 * выпадало бы из линта и одновременно из этой проверки, то есть молча. Nitro и Nuxt принимают `.js`
 * и `.tsx` без единой настройки, так что сценарий не гипотетический.
 */
const SOURCE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|vue)$/

const REQUIRED = ['@typescript-eslint/no-floating-promises', '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-misused-promises', 'no-control-regex']

/** Уровень `error` — числом (2) или строкой; всё остальное, включая `off`/`warn`, не годится. */
const isError = (entry: unknown): boolean => {
  const level = Array.isArray(entry) ? entry[0] : entry
  return level === 2 || level === 'error'
}

/**
 * Обход исходников — ОДИН на все проверки ниже. Раздельные обходы уже подвели: проверка подавлений
 * знала пять каталогов и не видела корень.
 */
const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output', '.git', 'coverage',
  'dist', 'test-results', 'reporting-kit', '__screenshots__'])

const walkSources = (): string[] => {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (SOURCE_EXT.test(entry.name)) found.push(relative(ROOT, full))
    }
  }
  walk(ROOT)
  return found
}

describe('ни один исходник не выпадает из линта молча', () => {
  it('для каждого файла ESLint резолвит наши правила', async () => {
    const { ESLint } = await import('eslint')
    const eslint = new ESLint({ cwd: ROOT })

    const sources = walkSources()
    expect(sources.length, 'обход не нашёл исходников — проверка выродилась').toBeGreaterThan(100)

    // Приманка нарушает правила намеренно и живёт в `ignores`; остального в списке быть не должно.
    // ⚠️ Размеры аллоу-листов запиннены: расширить их — значит поправить утверждение, а не дописать
    // слово в список. Ревью сняло защиту, добавив `'api'` в пропускаемые каталоги (сопоставление идёт
    // по базовому имени, так что одно слово гасило и `server/api`, и `src/api`).
    const KNOWN_UNCOVERED = new Set(['test/fixtures/floating-promise.fixture.ts'])

    // ⚠️ Пиннем РЕЗУЛЬТАТ обхода, а не размер списка. Размер от подмены не защищает: ревью заменило
    // `'dist'` (такого каталога в дереве нет) на `'obs'` — размер прежний, а из обхода ушло
    // телеметрическое ядро, то самое, ради висячего промиса в котором правился `span.ts`.
    for (const must of ['src/obs/span.ts', 'src/api/invitation.ts', 'src/store/pg.ts',
      'server/api/b24/install.post.ts', 'server/utils/portal.ts', 'app/app.vue',
      'app/utils/landing.ts', 'test/api.test.ts', 'scripts/verify.ts', 'otel.instrument.mjs']) {
      expect(sources, `обход потерял ${must} — защита снята подменой в списке пропускаемых каталогов`)
        .toContain(must)
    }
    expect(KNOWN_UNCOVERED.size, 'список известных исключений расширен').toBe(1)

    const uncovered: string[] = []
    for (const file of sources) {
      if (KNOWN_UNCOVERED.has(file)) continue
      const config = await eslint.calculateConfigForFile(file)
      // ⚠️ Проверяем УРОВЕНЬ, а не наличие. Выключенное правило резолвится как `[0]`, и проверка на
      // истинность его пропускала — ревью показало это блоком из четырёх строк, который гасил правила
      // для всего `server/api/**` (весь HTTP-периметр: установка, удаление, вебхуки событий), оставляя
      // все три слоя гарда зелёными. Уровень пиннится для КАЖДОГО файла, а не для представителей.
      for (const rule of REQUIRED) {
        if (!isError(config?.rules?.[rule])) uncovered.push(`${file} — ${rule}`)
      }
    }
    expect(uncovered, `правила не в состоянии error:\n${uncovered.join('\n')}`).toEqual([])
  })

  it('у трёх правил про промисы НЕТ опций — любые опции их только ослабляют', async () => {
    // ⚠️ Прежняя проверка искала опции со значением `false` — и была неверна дважды. У `ignoreVoid` и
    // `ignoreIIFE` ослабление это `true`, а не `false`; а `checksVoidReturn` штатно принимает ОБЪЕКТ
    // под-флагов, который под сравнение с `false` не подпадал вовсе. Ревью сняло обе защиты одной
    // правкой, оставив гард зелёным. Поэтому здесь запрет простой и неинвертируемый: у этих трёх
    // правил опций быть не должно — строгое состояние и есть состояние по умолчанию.
    const { ESLint } = await import('eslint')
    const eslint = new ESLint({ cwd: ROOT })
    const NO_OPTIONS = REQUIRED.filter((r) => r !== 'no-control-regex')

    for (const file of ['src/api/invitation.ts', 'server/utils/portal.ts', 'server/api/b24/install.post.ts',
      'app/utils/landing.ts', 'app/app.vue', 'test/api.test.ts', 'scripts/verify.ts', 'otel.instrument.mjs']) {
      const config = await eslint.calculateConfigForFile(file)
      // Без типов правила промисов не работают вовсе — а конфиг при этом выглядит настроенным.
      expect(config?.languageOptions?.parserOptions?.project, `${file}: нет привязки к проекту TypeScript`)
        .toBeTruthy()
      // Мёртвое подавление обязано быть ошибкой: это симптом правила, отключённого выше по цепочке.
      // Под обоснование этого в конфиге написан абзац, а сам флаг не был запиннен ничем.
      expect(isError(config?.linterOptions?.reportUnusedDisableDirectives),
        `${file}: мёртвое подавление перестало быть ошибкой`).toBe(true)
      for (const rule of NO_OPTIONS) {
        const entry = config?.rules?.[rule]
        expect(isError(entry), `${file}: ${rule} не в состоянии error`).toBe(true)
        expect(Array.isArray(entry) ? entry.length : 1, `${file}: у ${rule} появились опции — они его ослабляют`)
          .toBe(1)
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

  /**
   * ⚠️ Мало проверить, что линт ЗОВУТ, — надо проверить, что его отказ что-то значит. Ревью показало
   * три однострочные правки, каждая из которых оставляла все проверки зелёными: `|| true` в скрипте,
   * `continue-on-error: true` у шага CI и `|| true` в `check.sh`. Линт при этом печатает ошибку и
   * возвращает 0. Поэтому ищем не только вызов, но и глушители кода возврата рядом с ним.
   */
  it('pnpm check и CI зовут линт, и линт смотрит на весь проект', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.check, '`pnpm check` не зовёт линт').toContain('pnpm lint')
    // `eslint src` вместо `eslint .` — рабочий способ выключить линт для server/ и app/, не тронув конфиг.
    expect(pkg.scripts.lint, 'линт смотрит не на весь проект').toMatch(/eslint \.(\s|$)/)
    // Без `--max-warnings=0` любое предупреждение (в т.ч. мёртвое подавление) не роняет CI.
    expect(pkg.scripts.lint, 'предупреждения не гейтятся').toContain('--max-warnings=0')
    // Глушители кода возврата: `pnpm lint || true` печатает ошибку и завершается успехом.
    expect(pkg.scripts.lint, 'код возврата линта заглушён').not.toMatch(/\|\||;\s*(true|exit 0)/)
    expect(pkg.scripts.check, 'код возврата линта заглушён в check').not.toMatch(/pnpm lint\s*(\|\||;)/)

    const ci = read('.github/workflows/ci.yml')
    expect(ci, 'в CI нет шага линта').toMatch(/run:\s*pnpm lint/)
    // `continue-on-error: true` у шага делает его отказ безвредным — шаг есть, гейта нет.
    const lintStep = ci.slice(ci.indexOf('run: pnpm lint') - 400, ci.indexOf('run: pnpm lint') + 200)
    expect(lintStep, 'шагу линта разрешено падать').not.toMatch(/continue-on-error:\s*true/)

    for (const script of ['scripts/check.sh', 'scripts/check.ps1']) {
      const text = read(script)
      expect(text, `${script}: локальная проверка расходится с гейтом мержа`).toMatch(/pnpm -s lint/)
      expect(text, `${script}: код возврата линта заглушён`).not.toMatch(/pnpm -s lint\s*(\|\||;)/)
    }
    // В PowerShell отказ не прерывает скрипт сам — нужен явный разбор кода возврата после линта.
    const ps1 = read('scripts/check.ps1')
    expect(ps1.slice(ps1.indexOf('pnpm -s lint'), ps1.indexOf('pnpm -s lint') + 120),
      'check.ps1: после линта нет проверки кода возврата').toMatch(/LASTEXITCODE/)
  })

  it('в исходниках нет подавления линта целым файлом', () => {
    // ⚠️ Запрещена ЛЮБАЯ блочная директива `/* eslint-disable … */` — в том числе с именами правил.
    // Ревью показало обе дыры прежней проверки: она искала только безымянную форму (а `/* eslint-disable
    // @typescript-eslint/no-floating-promises */` глушит файл целиком ничуть не хуже) и обходила пять
    // каталогов, мимо корня — то есть мимо `otel.instrument.mjs`, прод-бутстрапа, ради которого
    // заводился `tsconfig.tooling.json` со словами «он весь про промисы».
    // Точечные `eslint-disable-next-line` остаются разрешёнными: они видны в диффе и объясняются рядом.
    const offenders: string[] = []
    for (const file of walkSources()) {
      if (file === relative(ROOT, fileURLToPath(import.meta.url))) continue // сам шаблон — литерал здесь
      if (/\/\*\s*eslint-disable(\s|\*)/.test(readFileSync(join(ROOT, file), 'utf8'))) offenders.push(file)
    }
    expect(offenders, `линт заглушён целиком в:\n${offenders.join('\n')}`).toEqual([])
  })
})
