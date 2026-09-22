/**
 * Переносит анкеты старого решения в смарт-процесс «Шаблон опроса» на портале клиента.
 *
 * ⚠ ПО УМОЛЧАНИЮ — СУХОЙ ПРОГОН. Записывает только с `--apply`. `docs/PROCESS.md` требует
 * именно такого порядка: «сухой прогон можно повторять сколько угодно раз, пока сверка
 * не сойдётся, и только потом писать». Повторный прогон с `--apply` тоже безопасен —
 * существующая пара «код + версия» не перезаписывается никогда.
 *
 * ⚠ ХОДИТ В ПОРТАЛ ВХОДЯЩИМ ВЕБХУКОМ, а не токенами приложения из нашей базы. Первая
 * редакция искала портал в базе и расшифровывала его токены — то есть требовала положить
 * на машину оператора боевой `DATABASE_URL` и ключ шифрования токенов ВСЕХ клиентов ради
 * разовой операции над одним. Панель ревью назвала это прямо, и это правда несоразмерно:
 * вебхук выдаётся клиентом на один портал, живёт сколько нужно и гасится после.
 *
 * Заодно снимается вопрос «а туда ли я пишу»: адрес вебхука содержит домен портала,
 * его видно в команде, и опечатка в домене не приведёт к записи другому клиенту —
 * чужой вебхук просто не выдадут.
 *
 *   pnpm migrate:templates --snapshot ~/снимок.txt --hook https://ПОРТАЛ/rest/1/КЛЮЧ/
 *   pnpm migrate:templates --snapshot ~/снимок.txt --hook https://ПОРТАЛ/rest/1/КЛЮЧ/ --apply
 *
 * ⚠ `--state published` СУЩЕСТВУЕТ, НО ОПАСЕН. Опубликованная версия неизменяема, а названий
 * анкет в источнике нет — опубликованные сразу, они навсегда останутся с машинными именами.
 * Скрипт предупреждает об этом и требует ещё и `--i-know` вдобавок к `--apply`.
 *
 * ⚠ Снимок содержит ответы живых клиентов заказчика. В репозиторий он не кладётся: скрипт
 * отказывается запускаться, если файл лежит внутри рабочего дерева git.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import { readLegacyTemplates } from '../server/domain/import/legacy-templates'
import { readSnapshot } from '../server/domain/import/snapshot'
import { DEFAULT_IMPORT_STATE, type TemplateState } from '../server/domain/import/template-write'
import type { RestCall } from '../server/b24/provision'
import { findTemplateProcess, writeTemplates } from '../server/b24/write-templates'

interface Args {
  snapshot: string
  hook: string
  apply: boolean
  state: TemplateState
  confirmed: boolean
}

function readArgs(argv: readonly string[]): Args {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? '' : (argv[at + 1] ?? '')
  }
  return {
    snapshot: value('snapshot'),
    hook: value('hook'),
    apply: argv.includes('--apply'),
    state: value('state') === 'published' ? 'published' : DEFAULT_IMPORT_STATE,
    confirmed: argv.includes('--i-know'),
  }
}

/**
 * Остановка с понятным сообщением.
 *
 * ⚠ `exitCode` вместо `process.exit()`: тот не дожидается слива stdout, и отчёт, уходящий
 * в `| tee migration.log`, теряет хвост — а хвост это как раз «НЕ ЗАПИСАНО» и предупреждение
 * про названия. Нашла панель ревью.
 *
 * ⚠ Бросаем помеченную ошибку, а не голую: `main` ловит её молча, без стека. Стек здесь —
 * шум ровно в тот момент, когда оператору нужен диагноз, а не разработчику место в коде.
 */
class Stop extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

function die(message: string, code = 2): never {
  throw new Stop(message, code)
}

/**
 * Вызов портала входящим вебхуком.
 *
 * ⚠ Ошибка портала поднимается исключением с КОДОМ в тексте: наверху её пропустит через
 * `safeRefusal`, который знает закрытый список кодов и наружу лишнего не выпустит.
 */
function hookCall(base: string): RestCall {
  const root = base.endsWith('/') ? base : `${base}/`
  return async (method, params = {}) => {
    const response = await fetch(`${root}${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    const body = await response.json() as { error?: string, error_description?: string }
    if (typeof body.error === 'string' && body.error !== '') {
      throw new Error(`${body.error}: ${body.error_description ?? ''}`)
    }
    return body
  }
}

async function main(): Promise<number> {
  const args = readArgs(process.argv.slice(2))

  if (args.snapshot === '' || args.hook === '') {
    die([
      'Нужны --snapshot <файл> и --hook <адрес входящего вебхука портала>.',
      '',
      '  pnpm migrate:templates --snapshot ~/снимок.txt --hook https://ПОРТАЛ/rest/1/КЛЮЧ/',
      '  … --apply                записать (по умолчанию сухой прогон)',
      '  … --state published      ОПАСНО: публикует сразу, требует ещё и --i-know',
    ].join('\n'))
  }

  if (!existsSync(args.snapshot)) die(`Снимок не найден: ${args.snapshot}`)

  // ⚠ Снимок — персональные данные клиентов заказчика. `.gitignore` их не удержит: оператор
  // назовёт файл как угодно, и `git add .` положит их в историю навсегда. Проверяем факт,
  // а не имя. Нашли двое проверяющих независимо.
  if (insideGitWorkTree(resolve(args.snapshot))) {
    die([
      `Снимок лежит внутри git-репозитория: ${resolve(args.snapshot)}`,
      'В нём ответы живых клиентов заказчика. Перенесите файл наружу — например, в домашний каталог.',
    ].join('\n'))
  }

  function insideGitWorkTree(file: string): boolean {
    try {
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dirname(file),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      return top !== ''
    }
    catch {
      // Каталога нет в репозитории — ровно то, что нужно.
      return false
    }
  }

  const { options, labels } = readSnapshot(readFileSync(args.snapshot, 'utf8'))

  if (options.length === 0) {
    die('В снимке не нашлась выгрузка `b_option` (запрос 1). Проверьте, что файл полный.')
  }

  // ⚠ БЕЗ ПОДПИСЕЙ НЕ ЗАПУСКАЕМСЯ, и это не педантичность. Формулировок вопросов
  // в конфигурации анкет НЕТ — они живут только в подписях полей. С пустым списком перенос
  // прошёл бы «успешно» и записал двенадцать анкет, у которых все сто с лишним вопросов
  // без единого слова текста. Починить повторным прогоном нельзя: существующая пара
  // «код + версия» не перезаписывается, и оператору пришлось бы удалять их руками
  // в портале клиента. Нашли двое проверяющих независимо.
  if (labels.length === 0) {
    die([
      'В снимке не нашлась выгрузка подписей полей (запрос 2).',
      'Без неё анкеты перенесутся с ПУСТЫМИ формулировками вопросов, и это не чинится',
      'повторным прогоном — существующая версия не перезаписывается.',
    ].join('\n'))
  }

  const { templates, warnings } = readLegacyTemplates(options, labels)
  console.info(`Снимок: ${options.length} строк настроек, ${labels.length} подписей полей.`)
  console.info(`Разобрано шаблонов: ${templates.length}.`)

  const empty = templates.flatMap(t => t.sections.flatMap(s => s.questions)).filter(q => q.title === '')
  if (empty.length > 0) {
    console.info(`\n⚠ Вопросов без формулировки: ${empty.length}. Подписи нашлись не для всех полей.`)
  }

  if (warnings.length > 0) {
    console.info(`\nПеренеслось не буквально — ${warnings.length}:`)
    for (const w of warnings) console.info(`  [${w.code}] ${w.template}/${w.at}: ${w.detail}`)
  }

  if (args.state === 'published' && !args.confirmed) {
    die([
      '',
      '--state published публикует версии НЕМЕДЛЕННО И НЕОБРАТИМО.',
      'Опубликованная версия неизменяема, а названий анкет в источнике нет — они останутся',
      'с машинными именами (brand, concept, design…) навсегда. Если это правда нужно,',
      'добавьте --i-know.',
    ].join('\n'), 3)
  }

  const call = hookCall(args.hook)
  const template = await findTemplateProcess(call)
  if (template === null) {
    die('\nСмарт-процесс «Шаблон опроса» на портале не найден. Сначала переустановка или «доустроить».', 1)
  }

  const result = await writeTemplates(call, template, templates, { apply: args.apply, state: args.state })

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
  else if (result.written > 0 && args.state === 'draft') {
    // ⚠ Названий анкет в источнике нет вовсе, поэтому все они называются своими кодами.
    // Опубликованная версия неизменяема — переименовать после публикации будет нельзя.
    console.info('\n⚠ Шаблоны записаны ЧЕРНОВИКАМИ и называются своими кодами: в источнике')
    console.info('  человеческих названий нет. Назовите их на портале и только потом публикуйте —')
    console.info('  опубликованная версия неизменяема, переименовать её уже не выйдет.')
  }

  return result.failed.length > 0 ? 1 : 0
}

/**
 * ⚠ Единственная точка, где что-то печатается наружу при беде. Без неё любой отказ
 * до цикла записи — недоступный портал, отказ `app.option.get`, обрыв на второй странице —
 * вылетал необработанным отклонением со стеком, при том что четыре соседних исхода
 * оформлены аккуратными русскими сообщениями. Асимметрию нашла панель ревью.
 */
try {
  process.exitCode = await main()
}
catch (error) {
  console.error(error instanceof Stop ? error.message : `\nНе получилось: ${(error as Error)?.message ?? error}`)
  process.exitCode = error instanceof Stop ? error.code : 1
}
