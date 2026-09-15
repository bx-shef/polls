#!/usr/bin/env node
/**
 * Fails when a layer imports from a layer it must not know about.
 *
 * Две границы, обе из `CLAUDE.md` и `docs/PROCESS.md`, и обе проверяются скриптом,
 * а не договорённостью:
 *
 * 1. `app/` и `shared/` не импортируют `server/`. Цена нарушения — ключи и SQL,
 *    уехавшие в клиентский бандл; замечают это не сразу, потому что приложение
 *    при этом прекрасно работает.
 * 2. `server/domain/` не импортирует `server/b24/` и `server/api/`. Домен не знает
 *    ни про HTTP, ни про REST — иначе его нельзя проверить без мока портала, и
 *    доменные тесты постепенно превращаются в интеграционные. Эта проверка появилась
 *    после того, как ревью нашло ровно такой импорт: чистая функция `eventCode`
 *    переехала из интеграции в домен вместе с разбором тела, и скрипт этого не увидел.
 *
 * Скрипт принимает корень проекта аргументом, чтобы его можно было натравить
 * на приманку из `tests/fixtures/layer-boundary` и доказать, что он ловит нарушение.
 *
 *   node scripts/check-layer-boundaries.mjs [root]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SOURCE_EXTENSIONS = ['.vue', '.ts', '.tsx', '.js', '.mjs', '.cjs']

/** Псевдонимы, ведущие в корень проекта: `~~/server/...` и его синонимы. */
const ROOT_ALIASES = ['~~/', '@@/', '~/', '@/']

// Обратные кавычки здесь наравне с обычными: `import(`~~/server/...`)` — рабочий
// способ протащить импорт, и без них гейт его молча пропускал.
const SPECIFIER_PATTERNS = [
  // import x from 'y' / export { x } from 'y'
  /\b(?:import|export)\b[^'"`();]*?\bfrom\s*['"`]([^'"`]+)['"`]/g,
  // import 'y'
  /\bimport\s*['"`]([^'"`]+)['"`]/g,
  // import('y') / require('y')
  /\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
]

function walk(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir)
  }
  catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      found.push(...walk(full))
    }
    else if (SOURCE_EXTENSIONS.some(ext => entry.endsWith(ext))) {
      found.push(full)
    }
  }
  return found
}

function specifiersOf(source) {
  const specifiers = []
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

/** Returns true when the specifier resolves into `targetDir`. */
function pointsAt(specifier, fileDir, targetDir, root) {
  for (const alias of ROOT_ALIASES) {
    if (specifier.startsWith(alias)) {
      const aliased = resolve(root, specifier.slice(alias.length))
      return aliased === targetDir || aliased.startsWith(targetDir + sep)
    }
  }
  if (specifier.startsWith('.')) {
    const target = resolve(fileDir, specifier)
    return target === targetDir || target.startsWith(targetDir + sep)
  }
  return false
}

function lineOf(source, specifier) {
  const index = source.indexOf(specifier)
  return index < 0 ? 1 : source.slice(0, index).split('\n').length
}

/**
 * Каталоги, попадающие в клиентский бандл.
 *
 * `shared/` наравне с `app/`: Nuxt 4 отдаёт его и на клиент тоже, поэтому модуль
 * оттуда утащит ключи и SQL в браузер ровно так же, а гейт, который смотрит
 * в один только `app/`, этого не увидит.
 */
const CLIENT_DIRS = ['app', 'shared']

/**
 * Правила «кому куда нельзя». `from` — каталог-нарушитель, `into` — запретные для него.
 *
 * Доменный слой указан вместе с `server/api/`: обработчик тоже часть транспорта,
 * и импорт из него в домен означал бы то же самое, что импорт из `server/b24/`.
 */
const RULES = [
  { from: CLIENT_DIRS, into: ['server'], what: 'клиентский код импортирует server/' },
  { from: ['server/domain'], into: ['server/b24', 'server/api'], what: 'домен импортирует интеграцию' },
]

function findLayerViolations(root) {
  const violations = []

  for (const rule of RULES) {
    const forbidden = rule.into.map(dir => resolve(root, dir))
    for (const dir of rule.from) {
      for (const file of walk(resolve(root, dir))) {
        const source = readFileSync(file, 'utf8')
        const fileDir = resolve(file, '..')
        for (const specifier of specifiersOf(source)) {
          if (forbidden.some(target => pointsAt(specifier, fileDir, target, root))) {
            violations.push({ file: relative(root, file), line: lineOf(source, specifier), specifier, what: rule.what })
          }
        }
      }
    }
  }
  return violations
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const root = resolve(process.argv[2] ?? process.cwd())
  const violations = findLayerViolations(root)

  if (violations.length > 0) {
    console.error(`Граница слоёв нарушена (${violations.length}).\n`)
    for (const { file, line, specifier, what } of violations) {
      console.error(`  ${file}:${line} → ${specifier}  (${what})`)
    }
    console.error('\nКлиентский бандл не должен видеть ключи и SQL; домен не должен знать про HTTP и REST.')
    process.exit(1)
  }

  console.log('Границы слоёв целы: app/ и shared/ не импортируют server/, домен не импортирует интеграцию.')
}
