/**
 * Предполётная проверка окружения: `pnpm env:check [файл]`.
 *
 * Зачем отдельной командой, если та же проверка идёт при старте: отчёт при старте живёт в логе
 * контейнера, то есть владелец узнаёт о проблеме ПОСЛЕ редеплоя и только если полезет в `docker logs`.
 * Перед живым прогоном на портале это дорого. Здесь — то же самое, но ДО запуска и с кодом возврата,
 * который можно поставить в конвейер.
 *
 * По умолчанию читает `.env.prod` (что уедет в прод), иначе `.env`. Значения переменных не печатаются.
 */
import { readFileSync, existsSync } from 'node:fs'
import { checkEnv } from '../src/obs/env-check'

/** Разбор `.env`: `КЛЮЧ=значение`, комментарии и пустые строки — мимо, кавычки по краям снимаются. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    const key = s.slice(0, eq).trim()
    let v = s.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[key] = v
  }
  return out
}

const arg = process.argv[2]
const file = arg ?? (existsSync('.env.prod') ? '.env.prod' : '.env')
if (!existsSync(file)) {
  console.error(`Файл ${file} не найден. Укажите путь: pnpm env:check путь/к/.env`)
  process.exit(2)
}

// Прод-профиль: проверяем строго, как будто это боевой запуск, — в этом и смысл предполётной проверки.
const report = checkEnv({ ...parseEnvFile(readFileSync(file, 'utf8')) }, { isProduction: true })

console.log(`Проверка окружения: ${file} (по прод-правилам)\n`)
for (const i of report.errors) console.log(`  ✗ ${i.name}\n    ${i.message}\n`)
for (const i of report.warnings) console.log(`  ⚠ ${i.name}\n    ${i.message}\n`)

if (report.errors.length === 0 && report.warnings.length === 0) {
  console.log('  ✓ Замечаний нет.')
  process.exit(0)
}
console.log(`Итого: ошибок ${report.errors.length}, предупреждений ${report.warnings.length}.`)
// Ненулевой код только на ошибках: предупреждения не должны валить конвейер.
process.exit(report.errors.length > 0 ? 1 : 0)
