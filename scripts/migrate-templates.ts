/**
 * Переносит анкеты старого решения в смарт-процесс «Шаблон опроса» на портале клиента.
 *
 * ⚠ ПО УМОЛЧАНИЮ — СУХОЙ ПРОГОН. Записывает только с `--apply`. `docs/PROCESS.md` требует
 * именно такого порядка: «сухой прогон можно повторять сколько угодно раз, пока сверка
 * не сойдётся, и только потом писать». Повторный прогон с `--apply` тоже безопасен —
 * существующая пара «код + версия» не перезаписывается никогда.
 *
 * ⚠ Запускает ЧЕЛОВЕК, а не приложение. Миграция — отдельная услуга (`docs/PROCESS.md`,
 * раздел 17), и портал называется доменом, который оператор видит у клиента.
 *
 *   pnpm migrate:templates --snapshot снимок.txt --domain b24-xxxx.bitrix24.by
 *   pnpm migrate:templates --snapshot снимок.txt --domain b24-xxxx.bitrix24.by --apply
 *
 * ⚠ Снимок в репозиторий НЕ кладётся ни при каких обстоятельствах: в нём ответы живых
 * клиентов заказчика. Файл живёт у оператора и передаётся путём.
 */
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// `.env` читает Nuxt, но не голый Node — как в `scripts/migrate.mjs`.
const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

const { readLegacyTemplates } = await import('../server/domain/import/legacy-templates')
const { callForPortal } = await import('../server/b24/from-record')
const { findPortalByDomain } = await import('../server/links/issue')
const { readStoredRefs } = await import('../server/b24/provision')
const { writeTemplates } = await import('../server/b24/write-templates')
const { DEFAULT_IMPORT_STATE } = await import('../server/domain/import/template-write')

type Args = { snapshot: string, domain: string, apply: boolean, state: 'draft' | 'published' }

function readArgs(argv: readonly string[]): Args {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? '' : (argv[at + 1] ?? '')
  }
  const state = value('state')
  return {
    snapshot: value('snapshot'),
    domain: value('domain'),
    apply: argv.includes('--apply'),
    state: state === 'published' ? 'published' : DEFAULT_IMPORT_STATE,
  }
}

/**
 * Разобрать выгрузку так, как её реально отдаёт консоль MySQL: четыре результата подряд
 * в одном текстовом файле, каждый со своей шапкой из `snapshot-queries.sql`.
 *
 * ⚠ Ищем по ЗАГОЛОВКАМ КОЛОНОК, а не по номерам строк. Номера съедут от одной лишней
 * пустой строки, и разбор молча возьмёт не тот кусок — а «молча не тот кусок» здесь значит
 * перенос чужих данных в портал клиента.
 */
function section(lines: readonly string[], header: string): string[][] {
  const at = lines.findIndex(line => line.trim() === header)
  if (at === -1) return []

  const rows: string[][] = []
  for (const line of lines.slice(at + 1)) {
    // Результат кончается там, где начинается следующий запрос или комментарий к нему.
    if (line.startsWith('--') || line.trim().startsWith('SELECT')) break
    if (line.trim() === '') continue
    rows.push(line.split('\t'))
  }
  return rows
}

const args = readArgs(process.argv.slice(2))
if (args.snapshot === '' || args.domain === '') {
  console.error('Нужны --snapshot <файл> и --domain <портал>. С --apply записывает, без него — сухой прогон.')
  process.exit(2)
}
if (!existsSync(args.snapshot)) {
  console.error(`Снимок не найден: ${args.snapshot}`)
  process.exit(2)
}

const lines = readFileSync(args.snapshot, 'utf8').split('\n')
const options = section(lines, 'name value').map(r => ({ name: r[0] ?? '', value: r[1] ?? '' }))
const labels = section(lines, 'source_table field user_type mandatory multiple sort title')
  .map(r => ({ template: (r[0] ?? '').replace('sh_qest_h_', ''), field: r[1] ?? '', title: r[6] ?? '' }))

if (options.length === 0) {
  console.error('В снимке не нашлась выгрузка `b_option` (запрос 1). Проверьте, что файл полный.')
  process.exit(2)
}

const { templates, warnings } = readLegacyTemplates(options, labels)
console.info(`Снимок: ${options.length} строк настроек, ${labels.length} подписей полей.`)
console.info(`Разобрано шаблонов: ${templates.length}.`)

if (warnings.length > 0) {
  console.info(`\nПеренеслось не буквально — ${warnings.length}:`)
  for (const w of warnings) console.info(`  [${w.code}] ${w.template}/${w.at}: ${w.detail}`)
}

const portal = await findPortalByDomain(args.domain)
if (portal === null) {
  console.error(`\nПортал ${args.domain} у нас не зарегистрирован — приложение на нём не установлено.`)
  process.exit(1)
}

const call = callForPortal(portal)
if (call === null) {
  console.error(`\nУ портала ${args.domain} нет пригодных токенов: состояние «${portal.status}». Нужна переустановка.`)
  process.exit(1)
}

const refs = await readStoredRefs(call)
if (refs.template === undefined) {
  console.error('\nСмарт-процесс «Шаблон опроса» на портале не найден. Сначала переустановка или «доустроить».')
  process.exit(1)
}

const result = await writeTemplates(call, refs.template, templates, { apply: args.apply, state: args.state })

console.info(`\n${result.dryRun ? '=== СУХОЙ ПРОГОН, ничего не записано ===' : '=== ЗАПИСЬ ==='}`)
console.info(`  состояние версий : ${args.state}`)
console.info(`  создать          : ${result.create.length}${result.dryRun ? '' : ` (записано ${result.written})`}`)
for (const c of result.create) console.info(`      ${c.code} v${c.version} — «${c.title}»`)
if (result.skip.length > 0) {
  console.info(`  пропущено        : ${result.skip.length}`)
  for (const s of result.skip) console.info(`      ${s.code} v${s.version} — ${s.reason}`)
}
if (result.failed.length > 0) {
  console.info(`  НЕ ЗАПИСАНО      : ${result.failed.length}`)
  for (const f of result.failed) console.info(`      ${f.code} v${f.version} — ${f.reason}`)
}

if (result.dryRun) {
  console.info('\nЧтобы записать, повторите с `--apply`.')
}
else if (args.state === 'draft' && result.written > 0) {
  // ⚠ Названий анкет в источнике нет вовсе, поэтому все они называются своими кодами.
  // Опубликованная версия неизменяема — переименовать после публикации будет нельзя.
  console.info('\n⚠ Шаблоны записаны ЧЕРНОВИКАМИ и называются своими кодами: в источнике')
  console.info('  человеческих названий нет. Назовите их на портале и только потом публикуйте —')
  console.info('  опубликованная версия неизменяема, переименовать её уже не выйдет.')
}

process.exit(result.failed.length > 0 ? 1 : 0)
