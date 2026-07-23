/**
 * Гард границы `~core` (issue #36, security): клиентский код (`app/**`) должен импортировать из
 * ядра ТОЛЬКО `~core/client` и `~core/domain` (чистая логика без секретов). Серверные слои ядра —
 * `~core/bitrix24`, `~core/store`, `~core/api`, `~core/obs` — server-only: их импорт в клиентский
 * бандл утащил бы крипто/OAuth-токены/SQL. Альяс `~core → src/` (см. `nuxt.config.ts`).
 *
 * Запуск: `pnpm check:boundary` (tsx). В CI — отдельный шаг. Чистое ядро `pnpm check` не трогает.
 * Логика разбора вынесена в `findBoundaryViolations` (под юнит-тестами `test/core-boundary.test.ts`);
 * здесь же тонкая IO-обёртка (обход `app/`, печать, exit-код).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Разрешённые клиенту сегменты ядра (чистые, без секретов). */
export const ALLOWED_CORE_SEGMENTS = ['client', 'domain'] as const
/** Server-only сегменты ядра — запрещены в клиентском бандле. */
export const SERVER_ONLY_CORE_SEGMENTS = ['bitrix24', 'store', 'api', 'obs'] as const

export interface BoundaryViolation {
  path: string
  line: number
  specifier: string
  reason: string
}

// `import …`, `import(…)`, `… from '…'`, `require('…')` — захватываем specifier (`matchAll`,
// без stateful lastIndex). Только настоящие импорты (после `from`/`import`/`require`).
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g
// Строки-комментарии пропускаем — иначе `// не импортируй from '~core/store'` даст ложное нарушение.
const COMMENT_LINE_RE = /^\s*(\/\/|\*|\/\*)/

/**
 * Чистый разбор: по списку клиентских файлов вернуть нарушения границы `~core`.
 * Нарушение — импорт `~core/<seg>` с `seg ∉ {client, domain}` (вкл. голый `~core`/`~core/index`),
 * либо прямой относительный импорт server-only слоя (`src/{bitrix24,store,api,obs}`).
 *
 * Ограничения (намеренно, чтобы гард оставался лёгким — фиксируем честно):
 * - строки-комментарии (`//`, `*`, `/*`) пропускаются целиком; редкий импорт в хвосте
 *   блочного комментария на одной строке с кодом теоретически возможен — практически нет;
 * - НЕ ловит транзитивные ре-экспорты: если `~core/domain`/`~core/client` сами начнут тянуть
 *   server-only, гард это не увидит. Инвариант «`src/domain` и `src/client` не зависят от
 *   server-only слоёв» держим отдельно (см. `docs/project-map.md`).
 */
export function findBoundaryViolations(files: Array<{ path: string; content: string }>): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []
  for (const { path, content } of files) {
    content.split('\n').forEach((lineText, i) => {
      if (COMMENT_LINE_RE.test(lineText)) return
      for (const m of lineText.matchAll(IMPORT_RE)) {
        const spec = m[1]
        if (spec === undefined) continue
        const reason = classify(spec)
        if (reason) violations.push({ path, line: i + 1, specifier: spec, reason })
      }
    })
  }
  return violations
}

/** Вернуть причину нарушения для specifier либо undefined, если импорт допустим. */
function classify(spec: string): string | undefined {
  // Граница по альясу ~core.
  if (spec === '~core' || spec.startsWith('~core/')) {
    const seg = spec === '~core' ? '' : spec.slice('~core/'.length).split('/')[0]
    if (!seg || seg === 'index') return 'импорт корня ~core (тянет index ядра с server-only)'
    if ((ALLOWED_CORE_SEGMENTS as readonly string[]).includes(seg)) return undefined
    return `~core/${seg} — server-only слой ядра, недоступен клиенту (только ~core/{client,domain})`
  }
  // Защита от обхода альяса прямым ОТНОСИТЕЛЬНЫМ путём в server-only слой ядра.
  // Только relative (`./`/`../`) — иначе ложно сработали бы npm-пакеты вида `@scope/src/api/...`.
  if (spec.startsWith('./') || spec.startsWith('../')) {
    for (const seg of SERVER_ONLY_CORE_SEGMENTS) {
      if (new RegExp(`(^|/)src/${seg}(/|$)`).test(spec)) {
        return `прямой импорт src/${seg} (server-only слой ядра) в обход границы ~core`
      }
    }
  }
  return undefined
}

/** Рекурсивно собрать клиентские исходники (.vue/.ts/.mts/.tsx) под dir. */
function collectFiles(dir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(vue|ts|mts|tsx)$/.test(name)) out.push({ path: full, content: readFileSync(full, 'utf8') })
    }
  }
  walk(dir)
  return out
}

/** CLI: обойти app/, проверить границу, отчитаться, выставить exit-код. */
function main(): void {
  const root = process.cwd()
  const appDir = join(root, 'app')
  const files = collectFiles(appDir)
  const violations = findBoundaryViolations(files)
  if (violations.length === 0) {
    console.log(`✓ Граница ~core соблюдена: ${files.length} клиентских файлов, нарушений нет.`)
    return
  }
  console.error(`✗ Нарушения границы ~core (${violations.length}):`)
  for (const v of violations) {
    console.error(`  ${relative(root, v.path)}:${v.line} — '${v.specifier}' → ${v.reason}`)
  }
  console.error('\nКлиент (app/**) импортирует из ядра ТОЛЬКО ~core/client и ~core/domain.')
  process.exitCode = 1
}

// Запуск как скрипт (не при импорте из теста).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
