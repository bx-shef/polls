#!/usr/bin/env node
/**
 * Fails when anything under `app/` imports a module from `server/`.
 *
 * Инвариант из `CLAUDE.md`: `app/` не импортирует серверные модули, и проверяется это
 * скриптом, а не договорённостью. Цена нарушения — ключи и SQL, уехавшие в клиентский
 * бандл; замечают это не сразу, потому что приложение при этом прекрасно работает.
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

const SPECIFIER_PATTERNS = [
  // import x from 'y' / export { x } from 'y'
  /\b(?:import|export)\b[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // import 'y'
  /\bimport\s*['"]([^'"]+)['"]/g,
  // import('y') / require('y')
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
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

/** Returns true when the specifier points into `<root>/server`. */
function pointsAtServer(specifier, fileDir, serverDir) {
  for (const alias of ROOT_ALIASES) {
    if (specifier.startsWith(alias)) {
      return specifier.slice(alias.length).startsWith('server/')
    }
  }
  if (specifier.startsWith('.')) {
    const target = resolve(fileDir, specifier)
    return target === serverDir || target.startsWith(serverDir + sep)
  }
  return false
}

function lineOf(source, specifier) {
  const index = source.indexOf(specifier)
  return index < 0 ? 1 : source.slice(0, index).split('\n').length
}

function findLayerViolations(root) {
  const appDir = resolve(root, 'app')
  const serverDir = resolve(root, 'server')
  const violations = []

  for (const file of walk(appDir)) {
    const source = readFileSync(file, 'utf8')
    const fileDir = resolve(file, '..')
    for (const specifier of specifiersOf(source)) {
      if (pointsAtServer(specifier, fileDir, serverDir)) {
        violations.push({ file: relative(root, file), line: lineOf(source, specifier), specifier })
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
    console.error(`Граница слоёв нарушена: app/ импортирует server/ (${violations.length}).\n`)
    for (const { file, line, specifier } of violations) {
      console.error(`  ${file}:${line} → ${specifier}`)
    }
    console.error('\nКлиентский бандл не должен видеть ключи и SQL. Вынесите общий код или ходите через /api.')
    process.exit(1)
  }

  console.log('Граница слоёв цела: app/ не импортирует server/.')
}
