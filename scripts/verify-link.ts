/**
 * Живая проверка пути «выпустили ссылку → человек ответил → ответ в портале».
 *
 * ⚠ ЭТА ПРОВЕРКА ДОКАЗЫВАЕТ ТО, ЧЕГО ЮНИТ-ТЕСТЫ НЕ МОГУТ СТРУКТУРНО: что делает ПОРТАЛ
 * с тем, что мы прислали. Issue #43 заводился по следам четырёх дефектов подряд (#37–#40),
 * из которых ТРИ поймались глазами на карточке, а не гейтом: связь со сделкой не настроилась,
 * флаг записался `N` вместо `Y`, дело родилось просроченным на три часа, «Результат: 9»
 * без ответов на вопросы. Ни один не ловится подделкой портала — все четыре про то, что
 * портал сделал с нашими данными.
 *
 * Поэтому проверка обязательно ПЕРЕЧИТЫВАЕТ записанное. «Отправили одно, портал записал
 * другое» — это три дефекта из четырёх, и ловится оно только сверкой после записи.
 *
 * ⚠ Проверка ПИШЕТ на портал: создаёт элемент «Опроса» и дело в истории сделки. Сухого
 * прогона у неё нет и быть не может — доказывать нечего, если ничего не произошло. Отсюда
 * требование к обстановке: только тестовый портал, адрес которого виден в команде.
 *
 *   pnpm verify:link --hook https://ПОРТАЛ/rest/1/КЛЮЧ/ --deal 2
 *   pnpm verify:link --hook … --deal 2 --base http://localhost:3000 --survey creativity
 *
 * Что нужно в окружении (обычно `.env.b24test`, он же подхватывается автоматически):
 *
 *   DATABASE_URL      та же база, что у запущенного приложения, — в неё пишется ссылка
 *   PUBLIC_BASE_URL   адрес, который попадёт В ССЫЛКУ (обязан быть https)
 *
 * ⚠ `--base` — это КУДА СТУЧИТСЯ САМА ПРОВЕРКА, и он может отличаться от адреса в ссылке:
 * при локальном прогоне приложение живёт на `http://localhost:3000`, а `https` в ссылке —
 * инвариант, который мы не обходим. Когда адреса разные, проверка говорит об этом вслух:
 * доказан путь, но не адрес.
 */
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { die, hookBatch, hookCall, report } from './-hook'
import { readAnswers, writeToPortal } from '../server/answers/deliver'
import { findProcesses } from '../server/b24/write-templates'
import { readAllPublishedTemplates } from '../server/b24/read-templates'
import { isDatabaseConfigured } from '../server/db/client'
import {
  activityOriginId,
  bindingKey,
  buildFindActivityCall,
  buildListBindingsCall,
  readBindingKeys,
  readFoundActivityId,
} from '../server/domain/answers/timeline-activity'
import { hashToken } from '../server/domain/links/token'
import { buildFieldName } from '../server/domain/portals/smart-processes'
import type { PublishedTemplate } from '../server/domain/invitations/portal-calls'
import { issueLink } from '../server/links/issue-flow'
import { publicBaseUrl } from '../server/utils/env'

interface Args {
  hook: string
  deal: number
  base: string
  survey: string
}

function readArgs(argv: readonly string[]): Args {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? '' : (argv[at + 1] ?? '')
  }
  return {
    hook: value('hook'),
    deal: Number(value('deal')),
    base: value('base'),
    survey: value('survey'),
  }
}

/** Шаг проверки: печатается сразу, чтобы при падении было видно, где именно встали. */
function step(text: string): void {
  console.log(`\n▸ ${text}`)
}

function ok(text: string): void {
  console.log(`  ✓ ${text}`)
}

/**
 * Сверка. Не совпало — останавливаемся немедленно.
 *
 * ⚠ Останавливаемся, а не копим список. След на портале уже есть, и каждый следующий шаг
 * пишет поверх непонятного состояния: разбираться потом придётся в том, что натворили
 * шаги, выполненные после первого расхождения.
 */
function expect(condition: unknown, text: string): asserts condition {
  if (condition) {
    ok(text)
    return
  }
  die(`  ✗ ${text}`, 1)
}

/** Ответы на анкету: балльные — восьмёрками, текстовые — меткой прогона. */
export function buildAnswers(template: PublishedTemplate, marker: string): Record<string, number | string | null> {
  const answers: Record<string, number | string | null> = {}
  let firstScale = true

  for (const section of template.schema.sections) {
    for (const question of section.questions) {
      if (question.type === 'scale') {
        // ⚠ ПЕРВЫЙ балльный вопрос остаётся БЕЗ ОТВЕТА, и это не экономия. «Нет ответа —
        // это `null`, а не ноль» — инвариант проекта, и здесь он проверяется на всём пути
        // целиком: от страницы до поля на портале. Старое решение заказчика на этом
        // и погорело, а подделкой такое не доказать.
        answers[question.key] = firstScale ? null : Math.min(8, question.scale?.max ?? 10)
        firstScale = false
        continue
      }
      answers[question.key] = question.type === 'text' ? marker : null
    }
  }

  return answers
}

/**
 * Как приложение объяснило отказ. Для сообщения проверки, а не для логики.
 *
 * ⚠ Существует потому, что первая редакция печатала «✗ ответ 200, анкета отдана (было 200)» —
 * то есть сообщала, что не сошлось, и умалчивала, что именно пришло. Оператор в этот момент
 * стоит перед выбором «чинить приложение или чинить проверку», и без тела ответа выбрать
 * нечем. Поймано на первом же живом прогоне.
 */
function why(body: Record<string, unknown>): string {
  const parts = [body.reason, body.title, body.detail, body.statusMessage]
    .filter((part): part is string => typeof part === 'string' && part !== '')
  return parts.length === 0 ? JSON.stringify(body).slice(0, 200) : parts.join(' — ')
}

/**
 * Запрос к нашему приложению. Тело разбирается всегда: отказ объясняется именно телом.
 *
 * Отдаёт и текст, и разобранный JSON: по адресу `/s/<токен>` живёт СТРАНИЦА и приезжает
 * HTML, а по `/api/s/<токен>` — данные. Проверке нужны оба, и путать их нельзя.
 */
async function app(base: string, path: string, body?: unknown): Promise<{ status: number, text: string, body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  }
  catch {
    // Не JSON — это нормально для страницы. Вызывающий смотрит на `text`.
  }
  return { status: response.status, text, body: parsed }
}

async function main(): Promise<number> {
  const args = readArgs(process.argv.slice(2))

  if (args.hook === '' || !Number.isInteger(args.deal) || args.deal <= 0) {
    die([
      'Нужны --hook <вебхук ТЕСТОВОГО портала> и --deal <номер сделки>.',
      '',
      '  pnpm verify:link --hook https://ПОРТАЛ/rest/1/КЛЮЧ/ --deal 2',
      '  … --base http://localhost:3000   куда стучаться (по умолчанию PUBLIC_BASE_URL)',
      '  … --survey <код>                 какую анкету брать (по умолчанию первую)',
      '',
      '⚠ Проверка ПИШЕТ на портал: создаёт элемент «Опроса» и дело в сделке.',
      '  Запускать только против тестового портала.',
    ].join('\n'))
  }

  if (!isDatabaseConfigured()) {
    die('Нет DATABASE_URL. Нужна та же база, что у запущенного приложения: ссылка пишется в неё.', 2)
  }

  const linkBase = publicBaseUrl()
  const base = args.base === '' ? linkBase : args.base.replace(/\/+$/, '')

  const call = hookCall(args.hook)
  const batch = hookBatch(args.hook)

  step('Смарт-процессы на портале')
  const { template: templateSp, survey: surveySp } = await findProcesses(call)
  if (templateSp === undefined || surveySp === undefined) {
    die('  ✗ Смарт-процессы «Опрос» и «Шаблон опроса» на портале не найдены. Сначала установка.', 1)
  }
  ok(`«Шаблон опроса» ${templateSp.entityTypeId}, «Опрос» ${surveySp.entityTypeId}`)

  step('Опубликованные анкеты')
  const published = await readAllPublishedTemplates(call, templateSp)
  const chosen = args.survey === ''
    ? published[0]
    : published.find(candidate => candidate.code === args.survey)
  if (chosen === undefined) {
    die(`  ✗ Опубликованных анкет ${published.length}; ${args.survey === '' ? 'выбирать не из чего' : `кода «${args.survey}» среди них нет`}.`, 1)
  }
  ok(`берём «${chosen.title}» (${chosen.code}, версия ${chosen.version})`)

  step('Выпуск ссылки — тем же кодом, что и вкладка сделки')
  const issued = await issueLink({
    call,
    batch,
    // ⚠ Портал у нас в базе может быть не заведён вовсе: проверка ходит вебхуком, а не
    // токенами приложения. Ссылке нужен ЛЮБОЙ существующий портал — она на него ссылается
    // внешним ключом, — поэтому берём тот, под которым лежит кэш схем этой же базы.
    portalId: await portalIdFor(new URL(args.hook).host),
    domain: new URL(args.hook).host,
    baseUrl: linkBase,
    survey: surveySp,
    dealId: args.deal,
    template: chosen,
    // Вебхук выдан от имени сотрудника; отдельного идентификатора у нас здесь нет,
    // и портал поставит ответственным владельца вебхука — это верно для проверки.
    assignedById: 0,
    managerName: 'Проверка verify:link',
  })
  if (!issued.ok) {
    die(`  ✗ Выпуск не прошёл: ${issued.reason === 'no-public-host' ? 'PUBLIC_BASE_URL не задан или не https' : 'портал не подтвердил создание элемента'}.`, 1)
  }
  const token = issued.url.slice(issued.url.lastIndexOf('/') + 1)
  ok(`элемент «Опроса» ${issued.itemId}, ссылка выпущена`)
  if (base !== linkBase) {
    console.log(`  · ссылка ведёт на ${linkBase}, стучусь в ${base}: доказан путь, но не адрес`)
  }

  step('Анкета открывается по самой ссылке')
  // ⚠ Проверяются ОБА адреса, и это не дубль. По `/s/<токен>` живёт СТРАНИЦА, она
  // рендерится на сервере, и «ссылка открывается» — это про то, что человек увидел
  // вопросы. По `/api/s/<токен>` приезжают данные, и только на них можно что-то сверить.
  // Первая редакция стучалась в страницу и разбирала ответ как JSON — то есть проверяла
  // вёрстку запросом к данным и падала на пустом теле.
  const page = await app(base, `/s/${token}`)
  const view = await app(base, `/api/s/${token}`)

  expect(page.status === 200, `страница отдана (ответ ${page.status})`)
  expect(view.body.ok === true, `данные отданы (ответ ${view.status}${view.body.ok === true ? '' : `: ${why(view.body)}`})`)

  const survey = view.body.survey as { title?: string, sections?: unknown[] } | undefined
  // ⚠ Сверка кэша с порталом. Публичная страница читает схему из НАШЕГО кэша, а не
  // из портала, — значит «та ли это анкета» проверяется только так. Поймано живьём:
  // строка кэша, оставшаяся от другого прогона по той же паре «код + версия»,
  // не перезаписывается (версия неизменяема) — и страница показывала чужую анкету.
  expect(survey?.title === chosen.title, `кэш отдаёт ту же анкету, что на портале: «${String(survey?.title)}»`)
  expect((survey?.sections?.length ?? 0) > 0, `секций в анкете: ${survey?.sections?.length ?? 0}`)
  expect(view.body.header !== null && view.body.header !== undefined, 'шапка со снимком сделки на месте')
  expect(page.text.includes(chosen.title), 'название анкеты есть в отданном сервером HTML')

  step('Ответ принимается')
  const marker = `verify:link ${new Date().toISOString()}`
  const answers = buildAnswers(chosen, marker)
  const first = await app(base, `/api/s/${token}`, answers)
  expect(first.body.ok === true, `ответ принят (ответ ${first.status}${first.body.ok === true ? '' : `: ${why(first.body)}`})`)

  step('Повторная отправка отбивается')
  const second = await app(base, `/api/s/${token}`, answers)
  expect(second.body.ok !== true, 'второй ответ не принят')
  expect(second.body.reason === 'completed', `причина отказа «completed» (была «${why(second.body)}»)`)

  step('Доставка в портал — той же функцией, что и воркер')
  // ⚠ Зовём `writeToPortal` напрямую, а не `drainInbox`. Воркер ходит в портал ТОКЕНАМИ
  // ПРИЛОЖЕНИЯ из нашей базы, а проверка — вебхуком: на тестовом портале приложение может
  // быть и не установлено. Бухгалтерия воркера (захват строки, откладывание, счётчик
  // попыток) проверяется настоящим Postgres в `tests/db/inbox-claim.test.ts`; здесь
  // доказывается другое — что делает ПОРТАЛ с тем, что мы записали.
  const buffered = await bufferedAnswer(hashToken(token))
  expect(buffered !== null, 'ответ лежит в буфере доставки')
  const bufferedAnswers = readAnswers(buffered!.payload)
  expect(bufferedAnswers !== null, 'буфер разбирается обратно в ответы')
  const outcome = await writeToPortal(call, surveySp, issued.itemId, chosen.schema, bufferedAnswers!)
  expect(outcome.ok, `портал принял запись${outcome.ok ? '' : `: ${outcome.reason}`}`)
  expect(outcome.ok && outcome.reported, 'дело в истории сделки записано')
  await forgetBuffered(buffered!.id)

  step('Перечитываем записанное')
  const item = await readSurveyItem(call, surveySp, issued.itemId)
  const stateField = buildFieldName(surveySp.id, 'STATE')
  const scoreField = buildFieldName(surveySp.id, 'SCORE')
  const answersField = buildFieldName(surveySp.id, 'ANSWERS')

  expect(item[stateField] === 'completed', `состояние «${String(item[stateField])}»`)
  expect(Number.isFinite(Number(item[scoreField])), `балл записан: ${String(item[scoreField])}`)
  const written = typeof item[answersField] === 'string' ? item[answersField] : ''
  expect(written !== '', `ответы записаны, ${written.length} символов`)
  // ⚠ Сверяем ИМЕННО то, что отправляли. Проверка «поле непустое» прошла бы и на дефекте
  // «Результат: 9 без ответов на вопросы» — том самом, который владелец поймал глазами.
  expect(written.includes(marker), 'в записанном есть текст, который мы отправляли')

  // ⚠ Сверяем ИМЕННО пропуск, а не только «что-то записалось». «Нет ответа — это `null`,
  // а не ноль» — инвариант проекта, и здесь он проверяется на всём пути: страница отдала
  // `null`, буфер его сохранил, доставка записала, портал сохранил. Старое решение
  // заказчика погорело ровно тут, и это единственный дефект его данных, который не починить.
  const skipped = Object.entries(answers).find(([, value]) => value === null)?.[0] ?? ''
  const parsed = JSON.parse(written) as Record<string, unknown>
  expect(skipped !== '' && parsed[skipped] === null, `пропущенный вопрос «${skipped}» записан как null, а не нулём`)

  step('Дело в истории сделки')
  const { count: activities, id: activityId } = await findActivity(call, issued.itemId)
  expect(activities === 1, `дел с нашей меткой: ${activities}`)

  step('Дело видно и в карточке «Опроса»')
  // ⚠ Дело создаётся владельцем-сделкой, а к элементу «Опроса» привязывается вторым шагом
  // (issue #44). Проверяется живьём, потому что подделкой этого не доказать: привязка
  // к НЕСУЩЕСТВУЮЩЕЙ сущности отвечает `{result: true}` — портал молча принимает
  // идентификатор, которого нет. «Вызов не упал» здесь не значит ничего; значит только
  // перечитанный список привязок.
  const bound = await readBindings(call, activityId!)
  expect(
    bound.has(bindingKey(surveySp.entityTypeId, issued.itemId)),
    `дело привязано к элементу «Опроса» (привязок всего: ${bound.size})`,
  )

  step('Повторная доставка не создаёт второго дела')
  // ⚠ Проверяется живьём, потому что подделкой это не доказать. Инвариант проекта:
  // «перед созданием — поиск существующего». Прежний `crm.timeline.comment.add` такого
  // не умел вовсе — второй вызов добавлял второй комментарий, и это стояло в коде
  // как принятый риск. Повтор доставки — обычное дело: воркер возвращает строку в очередь
  // при любом обрыве после записи.
  const again = await writeToPortal(call, surveySp, issued.itemId, chosen.schema, bufferedAnswers!)
  expect(again.ok, `повторная запись прошла${again.ok ? '' : `: ${again.reason}`}`)
  const afterRepeat = (await findActivity(call, issued.itemId)).count
  expect(afterRepeat === 1, `дел с нашей меткой после повтора: ${afterRepeat}`)

  console.log([
    '',
    'Проверка пройдена. Что она доказала:',
    '  выпущенная ссылка открывается, ответ по ней записывается в элемент смарт-процесса,',
    '  в сделке появляется ровно одно дело с нашей меткой, повторная отправка отбивается,',
    '  а записанное в портал совпадает с отправленным.',
    '',
    `След на портале оставлен намеренно: элемент «Опроса» ${issued.itemId} и дело в сделке ${args.deal}.`,
    'Его и смотрят глазами, когда проверка вдруг разойдётся с тем, что видно в карточке.',
  ].join('\n'))

  return 0
}

/** Сколько дел с нашей меткой висит на этом элементе и какое из них первое. Ждём ровно одно. */
async function findActivity(
  call: ReturnType<typeof hookCall>,
  itemId: number,
): Promise<{ count: number, id: string | null }> {
  const find = buildFindActivityCall(activityOriginId(itemId))
  const answer = await call(find.method, find.params) as { result?: unknown }
  return {
    count: Array.isArray(answer.result) ? answer.result.length : 0,
    id: readFoundActivityId(answer),
  }
}

/** Привязки дела, перечитанные с портала. */
async function readBindings(call: ReturnType<typeof hookCall>, activityId: string): Promise<Set<string>> {
  const list = buildListBindingsCall(activityId)
  return readBindingKeys(await call(list.method, list.params))
}

/**
 * Строка буфера по хешу токена — и её удаление после доставки.
 *
 * ⚠ Оба запроса свои, а не общие с воркером, и это осознанно. У воркера они вплетены
 * в захват строки под блокировкой (`claimPending`, `forget`) — механику, которая здесь
 * не проверяется и которую нельзя дёргать по частям, не соврав о том, что доказано.
 * Запросы при этом тривиальны: найти по уникальному хешу и удалить по идентификатору.
 *
 * ⚠ Строка УДАЛЯЕТСЯ. Оставить её значило бы отдать тот же ответ настоящему воркеру,
 * когда тот в следующий раз пройдёт по буферу, — и в тестовой базе накопились бы строки,
 * которые никто не просил доставлять дважды.
 */
async function bufferedAnswer(tokenHash: string): Promise<{ id: string, payload: unknown } | null> {
  const { getDb, schema } = await import('../server/db/client')
  const { eq } = await import('drizzle-orm')

  const rows = await getDb()
    .select({ id: schema.inbox.id, payload: schema.inbox.payload })
    .from(schema.inbox)
    .where(eq(schema.inbox.tokenHash, tokenHash))
    .limit(1)

  return rows[0] ?? null
}

async function forgetBuffered(id: string): Promise<void> {
  const { getDb, schema } = await import('../server/db/client')
  const { eq } = await import('drizzle-orm')

  await getDb().delete(schema.inbox).where(eq(schema.inbox.id, id))
}

/**
 * Портал, под которым писать ссылку.
 *
 * ⚠ Ищем ПО ДОМЕНУ ВЕБХУКА, а не «первый попавшийся». Первая редакция брала первую строку
 * таблицы — и на первом же живом прогоне это выстрелило: кэш схем пишется по паре
 * «портал + код + версия», а опубликованная версия неизменяема, поэтому строка от другого
 * портала не перезаписывается. Страница показывала анкету, лежавшую там раньше, а проверка
 * сравнивала её с портальной и падала. Диагноз был верный, причина — в самой проверке.
 *
 * ⚠ Строка ЗАВОДИТСЯ, если её нет. Это не фикция: портал настоящий, тот самый, чей вебхук
 * стоит в команде, — просто приложение на него могло быть не установлено, а у ссылки внешний
 * ключ. Токенов у такой строки нет, и воркер доставки её пропустит — доставку в этой проверке
 * делает не он.
 */
async function portalIdFor(host: string): Promise<string> {
  const { getDb, schema } = await import('../server/db/client')
  const { eq } = await import('drizzle-orm')

  const found = await getDb()
    .select({ id: schema.portals.id })
    .from(schema.portals)
    .where(eq(schema.portals.domain, host))
    .limit(1)
  if (found.length > 0) return found[0]!.id

  const created = await getDb()
    .insert(schema.portals)
    .values({ memberId: `verify-link:${host}`, domain: host })
    .returning({ id: schema.portals.id })

  console.log(`  · портал ${host} заведён в базе под проверку: приложение на него не установлено`)
  return created[0]!.id
}

/** Перечитать элемент «Опроса» — тем же вызовом, каким его читает доставка. */
async function readSurveyItem(
  call: ReturnType<typeof hookCall>,
  survey: { entityTypeId: number, id: number },
  itemId: number,
): Promise<Record<string, unknown>> {
  const answer = await call('crm.item.get', {
    entityTypeId: survey.entityTypeId,
    id: itemId,
    useOriginalUfNames: 'Y',
  }) as { result?: { item?: Record<string, unknown> } }

  return answer.result?.item ?? {}
}

/**
 * ⚠ Запускаемся, только когда нас позвали КОМАНДОЙ, а не импортировали. Гвард
 * на `buildAnswers` живёт в `tests/unit/verify-link.test.ts` и импортирует этот файл;
 * без проверки он уходил бы стучаться в портал прямо из `pnpm check`.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then(code => process.exit(code))
    .catch((error: unknown) => process.exit(report(error)))
}
