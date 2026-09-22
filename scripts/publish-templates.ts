/**
 * Публикует названные черновики «Шаблона опроса»: имя элемента уезжает в схему, состояние
 * становится `published`, и анкета появляется в выпадающем списке вкладки сделки.
 *
 * ⚠ ПОРЯДОК ДЕЙСТВИЙ ОБРАТНЫЙ ПРИВЫЧНОМУ: сначала назвать, потом публиковать. Перенос кладёт
 * анкеты черновиками и называет их кодами, потому что человеческих названий в источнике нет
 * вовсе. Сотрудник переименовывает элементы на портале — а этот скрипт переносит название
 * ВНУТРЬ схемы. Респондент видит именно её, и после публикации версия неизменяема.
 *
 * ⚠ И ЧИНИТ ТО, ЧТО УЖЕ ОПУБЛИКОВАЛИ РАНЬШЕ ВРЕМЕНИ. Поле «Состояние» на портале — обычная
 * строка, и владелец может вписать в неё `published` руками, не дойдя до названий. Тогда
 * анкета опубликована, а зовут её «brand». Скрипт переименует такую — но только пока её
 * никто не прошёл: появилась статистика, значит инвариант вступил в силу и нужна новая
 * версия. Проверяется по числу пройденных «Опросов», а не по доверию.
 *
 * ⚠ ПО УМОЛЧАНИЮ — СУХОЙ ПРОГОН. Меняет что-либо только с `--apply`. Повторный запуск
 * безопасен: то, где название уже на месте, не трогается вовсе.
 *
 *   pnpm publish:templates --hook https://ПОРТАЛ/rest/1/КЛЮЧ/
 *   pnpm publish:templates --hook https://ПОРТАЛ/rest/1/КЛЮЧ/ --apply
 *
 * Неназванные анкеты скрипт не публикует и называет поимённо: имя, совпадающее с кодом, —
 * это не название, а заглушка переноса.
 */
import process from 'node:process'

import { die, hookCall, report } from './-hook'
import { findProcesses } from '../server/b24/write-templates'
import { publishTemplates } from '../server/b24/publish-templates'

interface Args {
  hook: string
  apply: boolean
}

function readArgs(argv: readonly string[]): Args {
  const at = argv.indexOf('--hook')
  return {
    hook: at === -1 ? '' : (argv[at + 1] ?? ''),
    apply: argv.includes('--apply'),
  }
}

async function main(): Promise<number> {
  const args = readArgs(process.argv.slice(2))

  if (args.hook === '') {
    die([
      'Нужен --hook <адрес входящего вебхука портала>.',
      '',
      '  pnpm publish:templates --hook https://ПОРТАЛ/rest/1/КЛЮЧ/',
      '  … --apply    опубликовать (по умолчанию сухой прогон)',
    ].join('\n'))
  }

  const call = hookCall(args.hook)
  const { template, survey } = await findProcesses(call)
  if (template === undefined) {
    die('Смарт-процесс «Шаблон опроса» на портале не найден. Сначала переустановка или «доустроить».', 1)
  }
  if (survey === undefined) {
    // ⚠ Без «Опроса» не сосчитать, кто уже прошёл анкету, — а значит не отличить версию,
    // которую можно переименовать, от той, по которой собрана статистика. Продолжать вслепую
    // хуже, чем остановиться: мы бы разрешили ровно то, что запрещает инвариант.
    die('Смарт-процесс «Опрос» на портале не найден — не сосчитать выпущенные приглашения.', 1)
  }

  // ⚠ Называем, ЧТО именно посчитали. В вебхучном режиме смарт-процессы находятся по заголовку,
  // а заголовок не признак владения: совпасть может процесс, заведённый клиентом руками. Тогда
  // сводка по пройденным опросам окажется пустой, и переименование откроется там, где не должно.
  // Оператор обязан иметь возможность сверить числа глазами. Нашёл `/code-review` в PR #50.
  console.info(`Смарт-процессы: «Шаблон опроса» entityTypeId ${template.entityTypeId}, «Опрос» ${survey.entityTypeId}.`)

  const result = await publishTemplates(call, template, survey, { apply: args.apply })

  const fresh = result.publish.filter(p => p.action === 'publish')
  const renamed = result.publish.filter(p => p.action === 'rename')

  console.info(`\n${result.dryRun ? '=== СУХОЙ ПРОГОН, ничего не изменено ===' : '=== ПУБЛИКАЦИЯ ==='}`)
  console.info(`  всего изменений : ${result.publish.length}${result.dryRun ? '' : ` (сделано ${result.published})`}`)
  if (fresh.length > 0) {
    console.info(`  опубликовать    : ${fresh.length}`)
    for (const p of fresh) console.info(`      ${p.code} v${p.version} — «${p.name}»`)
  }
  if (renamed.length > 0) {
    // ⚠ Отдельным блоком: переименование уже опубликованной версии выглядит как нарушение
    // инварианта, и оператор обязан видеть, что оно коснулось только непройденных анкет.
    console.info(`  переименовать   : ${renamed.length} (опубликованы, но ещё никем не пройдены)`)
    for (const p of renamed) {
      const tail = p.issued > 0 ? ` — ⚠ уже выпущено ссылок: ${p.issued}, они покажут прежнее название` : ''
      console.info(`      ${p.code} v${p.version} — «${p.name}»${tail}`)
    }
  }

  // ⚠ Отбираем по машинному признаку `kind`, а не по началу русской фразы: переформулировав
  // причину, мы бы молча погасили весь блок «НЕ НАЗВАНЫ», и оператор закрыл бы терминал
  // в уверенности, что делать нечего. Нашёл `/code-review` в PR #50.
  const unnamed = result.skip.filter(s => s.kind === 'unnamed')
  const other = result.skip.filter(s => s.kind !== 'unnamed')

  if (other.length > 0) {
    console.info(`  пропущено    : ${other.length}`)
    for (const s of other) console.info(`      ${s.code} v${s.version} — ${s.reason}`)
  }

  if (result.failed.length > 0) {
    console.info(`  НЕ ВЫШЛО     : ${result.failed.length}`)
    for (const f of result.failed) console.info(`      ${f.code} v${f.version} — ${f.reason}`)
  }

  if (unnamed.length > 0) {
    // ⚠ Отдельным блоком и в конце, а не строкой среди пропущенных: это единственное,
    // что требует действия человека, и именно это он должен увидеть, закрывая терминал.
    console.info(`\n⚠ НЕ НАЗВАНЫ — не опубликованы: ${unnamed.length}`)
    for (const s of unnamed) console.info(`      ${s.code} v${s.version} — ${s.reason}`)
    console.info('\n  Откройте смарт-процесс «Шаблон опроса» на портале и переименуйте эти элементы')
    console.info('  по-человечески, затем повторите. Название видит респондент, и после публикации')
    console.info('  оно уже не меняется — версия неизменяема.')
  }

  if (result.dryRun && result.publish.length > 0) {
    console.info('\nЧтобы применить, повторите с `--apply`.')
  }

  return result.failed.length > 0 ? 1 : 0
}

/** Единственная точка, где что-то печатается наружу при беде. */
try {
  process.exitCode = await main()
}
catch (error) {
  process.exitCode = report(error)
}
