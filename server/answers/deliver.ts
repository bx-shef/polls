import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { callForPortal } from '../b24/from-record'
import { readStoredRefs } from '../b24/provision'
import type { RestCall } from '../b24/provision'
import type { SmartProcessRef } from '../domain/portals/smart-processes'
import { getDb, schema } from '../db/client'
import { buildAnswerComment } from '../domain/answers/comment'
import { safeRefusal } from '../domain/answers/portal-errors'
import {
  buildCompleteSurveyCall,
  buildReadSurveyItemCall,
  parentFieldNames,
  readAssignedById,
  readParentDealId,
  readUpdatedItemId,
} from '../domain/answers/portal-calls'
import {
  ACTIVITY_COLOR_BAD,
  ACTIVITY_COLOR_GOOD,
  activityDeadline,
  activityOriginId,
  buildActivityMarkerCall,
  buildActivityTitle,
  buildDeleteActivityCall,
  buildFindActivityCall,
  buildTodoActivityCall,
  hasBadSection,
  readCreatedActivityId,
  readMarkApplied,
  readFoundActivityId,
} from '../domain/answers/timeline-activity'
import { DEAL_ENTITY_TYPE_ID } from '../domain/invitations/portal-calls'
import { purgeBoundary } from '../domain/portals/lifecycle'
import type { AnswerValue } from '../domain/surveys/answer'
import type { SurveyTemplate } from '../domain/surveys/model'
import { scoreSurvey } from '../domain/surveys/scoring'
import { findPortalById } from '../links/issue'
import { findLinkByTokenHash, findTemplate } from '../links/store'
import { logger } from '../utils/logger'

/**
 * Delivers buffered answers into the portal.
 *
 * Это вторая половина инварианта «ответ клиента не теряется никогда». Первая — приём в буфер
 * одной транзакцией со страницы; здесь буфер разбирается.
 *
 * ⚠ Очереди тут нет намеренно, и это отступление от `docs/PROCESS.md`, где обещан BullMQ.
 * Причина: ответ УЖЕ лежит в Postgres, durable, со статусом и счётчиком попыток. Задание
 * в Redis, указывающее на эту же строку, было бы вторым мнением о том, что подлежит доставке,
 * — а при потере Redis строку всё равно пришлось бы находить обходом таблицы. То есть обход
 * таблицы нужен в любом случае, и очередь добавляет к нему только своё расписание. Берём
 * `FOR UPDATE SKIP LOCKED`: он даёт ровно то, ради чего очередь и звали, — два экземпляра
 * приложения не возьмут одну строку дважды, — и не заводит второго источника правды.
 *
 * Вернуться к BullMQ стоит, когда появятся напоминания по расписанию: вот там своего
 * планировщика у Postgres нет, и писать его самим — как раз то, чего делать не надо.
 */

/**
 * ⚠ Часть функций ниже экспортируется РАДИ ТЕСТОВ, и это осознанный выбор, а не забывчивость.
 * Тот же приём, что в `server/b24/provision.ts`: они принимают `RestCall` параметром, значит
 * проверяются подделкой вызова, без сети и без базы. Панель ревью PR #22 нашла этот файл
 * с нулём тестов при том, что это единственный канал, которым ответ клиента попадает в CRM.
 * Альтернатива — прятать их и не проверять — дороже: дефект в этом файле уже случился один раз
 * (см. `requeueStuck` и время захвата) и уехал без гварда.
 */

/** Сколько ответов берём за один заход. Объём крошечный, гнаться не за чем. */
const BATCH = 10

/**
 * Сколько раз пробуем, прежде чем сдаться.
 *
 * ⚠ Исчерпав попытки, строку НЕ удаляем: в ней ответ живого человека, которого портал
 * не принял. Она переходит в `failed`, остаётся видимой и ждёт человека. Это единственное
 * состояние, в котором ответ клиента живёт у нас дольше доставки, — и оно громкое,
 * а не тихое, что и отличает его от нарушения инварианта.
 */
const MAX_ATTEMPTS = 8

/** Пауза перед следующей попыткой: 1, 2, 4… минуты, не больше часа. */
export function backoffMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1))
}

interface BufferedAnswer {
  id: string
  portalId: string
  tokenHash: string
  payload: unknown
  attempts: number
}

export type DeliveryOutcome
  = | { ok: true, itemId: number, reported: boolean }
    | { ok: false, retry: boolean, reason: string }

/**
 * Разобрать порцию буфера.
 *
 * Возвращает, сколько ответов доставлено и сколько отложено, — этого хватает и журналу,
 * и отчёту о здоровье. Наружу не уходит ничего, по чему можно восстановить сам ответ.
 */
export async function drainInbox(limit = BATCH): Promise<{ delivered: number, deferred: number, failed: number }> {
  const claimed = await claimPending(limit)
  let delivered = 0
  let deferred = 0
  let failed = 0

  for (const row of claimed) {
    const outcome = await deliverOne(row)
    if (outcome.ok) {
      await forget(row.id)
      delivered += 1
      continue
    }

    const exhausted = !outcome.retry || row.attempts + 1 >= MAX_ATTEMPTS
    await release(row, outcome.reason, exhausted)
    if (exhausted) failed += 1
    else deferred += 1
  }

  return { delivered, deferred, failed }
}

/**
 * Забрать строки, пометив их «в работе».
 *
 * ⚠ `FOR UPDATE SKIP LOCKED` — то, ради чего всё это без очереди и работает. Два экземпляра
 * приложения, запустившие разбор одновременно, разойдутся по разным строкам вместо того,
 * чтобы подраться за одну и записать ответ в портал дважды. Без `SKIP LOCKED` второй просто
 * ждал бы первого, и параллельность превратилась бы в очередь из одного.
 *
 * `received_at` в порядке — ответы доставляются в том порядке, в каком их дали.
 */
async function claimPending(limit: number): Promise<BufferedAnswer[]> {
  const now = new Date()
  const rows = await getDb().transaction(async (tx) => {
    const found = await tx
      .select({ id: schema.inbox.id })
      .from(schema.inbox)
      .where(and(
        eq(schema.inbox.status, 'pending'),
        lt(schema.inbox.nextAttemptAt, now),
      ))
      .orderBy(schema.inbox.receivedAt)
      .limit(limit)
      .for('update', { skipLocked: true })

    const ids = found.map(row => row.id)
    if (ids.length === 0) return []

    return tx
      .update(schema.inbox)
      // ⚠ `nextAttemptAt` обновляется вместе со статусом, и это не косметика: по нему
      // `requeueStuck` отличает строку, взятую только что, от брошенной умершим процессом.
      .set({ status: 'sending', nextAttemptAt: now })
      .where(inArray(schema.inbox.id, ids))
      .returning({
        id: schema.inbox.id,
        portalId: schema.inbox.portalId,
        tokenHash: schema.inbox.tokenHash,
        payload: schema.inbox.payload,
        attempts: schema.inbox.attempts,
      })
  })

  return rows
}

/**
 * Доставить один ответ.
 *
 * Порядок шагов важен ровно в одном месте: элемент смарт-процесса обновляется ПЕРВЫМ.
 * После него ответ живёт в портале, то есть в источнике истины, и наш буфер перестаёт быть
 * единственным местом, где он есть. Комментарий в таймлайн — удобство для менеджера,
 * и его неудача не повод откладывать саму доставку.
 */
export async function deliverOne(row: BufferedAnswer): Promise<DeliveryOutcome> {
  // ⚠ `try` охватывает ВСЁ тело, включая три обращения к базе. Сначала он начинался только
  // перед записью в портал — и это была единственная асимметрия в файле: обрыв к Postgres
  // на поиске ссылки улетал из `deliverOne` необработанным, рвал цикл `drainInbox`, и остаток
  // уже захваченной пачки — до девяти ответов — оставался в `sending` ждать `requeueStuck`,
  // то есть пятнадцать минут, при живом процессе, тикающем раз в минуту. Нашла панель ревью
  // PR #22.
  try {
    const answers = readAnswers(row.payload)
    if (answers === null) {
      // Содержимое буфера испорчено. Повторять нечего: следующая попытка разберёт то же самое.
      return { ok: false, retry: false, reason: 'буфер не разобрался' }
    }

    const link = await findLinkByTokenHash(row.tokenHash)
    if (link === null) return { ok: false, retry: false, reason: 'ссылка не найдена' }

    const template = await findTemplate(link.portalId, link.surveyCode, link.surveyVersion)
    if (template === null) return { ok: false, retry: false, reason: 'схема версии не найдена в кэше' }

    const portal = await findPortalById(row.portalId)
    if (portal === null || portal.status === 'deleted') {
      // Портал удалил приложение. Долбиться в него больше нельзя — это инвариант,
      // и повторять такую задачу бессмысленно.
      return { ok: false, retry: false, reason: 'портал удалил приложение' }
    }

    const call = callForPortal(portal)?.call ?? null
    if (call === null) return { ok: false, retry: true, reason: 'у портала нет пригодных токенов' }

    const survey = await resolveSurveyProcess(call)
    if (!('entityTypeId' in survey)) return survey

    return await writeToPortal(call, survey, link.itemId, template, answers)
  }
  catch (error) {
    // ⚠ Наружу уходит НАШ код отказа, а не текст портала. Текст портала цитирует присланное
    // значение — а присланное значение здесь и есть ответ клиента. См. `portal-errors.ts`.
    // База сюда тоже попадает: её ошибка так же не должна утечь в журнал целиком.
    return { ok: false, retry: true, reason: safeRefusal(error) }
  }
}

/**
 * Найти смарт-процесс «Опрос» — или сказать, почему записывать пока нечем.
 *
 * ⚠ Отдельной функцией, и это не дробление ради дробления. Раньше поиск стоял внутри
 * `writeToPortal`, и там его держал названный гвард: «просит повторить, когда смарт-процесс
 * на портале не найден». Смарт-процессы создаются при установке, их отсутствие лечится
 * переустановкой — но повторить стоит, потому что установка могла идти прямо сейчас.
 * Разделив запись и поиск (см. шапку `writeToPortal`), легко было бы уронить гвард молча:
 * он проверял ветку, которой в новой `writeToPortal` нет. Здесь ему есть за что держаться.
 *
 * Возвращает либо сам смарт-процесс, либо готовый исход доставки — вызывающему остаётся
 * отличить одно от другого и пробросить второе наверх.
 */
export async function resolveSurveyProcess(call: RestCall): Promise<SmartProcessRef | DeliveryOutcome> {
  const refs = await readStoredRefs(call)
  if (refs.survey === undefined) {
    return { ok: false, retry: true, reason: 'смарт-процесс «Опрос» не найден на портале' }
  }
  return refs.survey
}

/**
 * Записать ответ в портал: элемент смарт-процесса, потом дело в истории сделки.
 *
 * ⚠ Смарт-процесс приходит ПАРАМЕТРОМ, а не читается здесь. Сначала читался — и это делало
 * функцию непригодной для живой проверки `pnpm verify:link`: `readStoredRefs` ходит
 * в `app.option.get`, а тот под входящим вебхуком отвечает `ACCESS_DENIED: Application
 * context required` (проверено на живом портале). Проверка нашла бы смарт-процессы иначе —
 * по заголовку, как операторские команды, — но позвать эту функцию всё равно не смогла бы
 * и была бы вынуждена повторить запись своей копией. Копии расходятся.
 */
export async function writeToPortal(
  call: RestCall,
  survey: SmartProcessRef,
  itemId: number,
  template: SurveyTemplate,
  answers: Record<string, AnswerValue>,
): Promise<DeliveryOutcome> {
  const score = scoreSurvey(template, answers)

  const update = buildCompleteSurveyCall(survey, itemId, { answers, score, completedAt: new Date() })
  const updated = readUpdatedItemId(await call(update.method, update.params))
  if (updated === null) return { ok: false, retry: true, reason: 'портал не подтвердил обновление элемента' }

  // Дальше — только удобство. Всё, что было обязательным, уже в портале.
  const reported = await tryTimelineActivity(call, survey, itemId, template, answers, score)
  return { ok: true, itemId: updated, reported }
}

/**
 * Положить итог в историю сделки — ДЕЛОМ, а не комментарием.
 *
 * ⚠ Неудача здесь НЕ проваливает доставку: ответ уже в портале, в элементе смарт-процесса.
 * Но, в отличие от прежнего комментария, повторить это МОЖНО без последствий — у дела есть
 * метка внешнего источника, и перед созданием мы ищем уже записанное. `crm.timeline.comment.add`
 * такого не умел вовсе: второй вызов добавлял второй комментарий, и это стояло в коде
 * как принятый риск, прямо противоречащий инварианту «перед созданием — поиск существующего».
 *
 * ⚠ КАЖДЫЙ выход отсюда пишет строку в журнал. Первая редакция логировала только исключение,
 * два других выхода возвращали `false` молча, и состояние «ответ в портале, записи в сделке
 * нет» было ненаблюдаемым по построению. Необязательный шаг молчит ровно до того дня, когда
 * он и есть то, ради чего всё затевалось.
 */
export async function tryTimelineActivity(
  call: RestCall,
  survey: SmartProcessRef,
  itemId: number,
  template: SurveyTemplate,
  answers: Record<string, AnswerValue>,
  score: ReturnType<typeof scoreSurvey>,
): Promise<boolean> {
  try {
    const read = buildReadSurveyItemCall(survey, itemId)
    const item = await call(read.method, read.params)
    const dealId = readParentDealId(item, DEAL_ENTITY_TYPE_ID)
    if (dealId === null) {
      // ⚠ В журнал уходят ИМЕНА полей связи, а не значения: имя описывает схему
      // смарт-процесса, значение указывает на клиента портала. Имена нужны потому, что
      // «связи нет» и «связь названа иначе, чем мы ждём» — разные беды с одинаковым `null`.
      logger.warn({ parentFields: parentFieldNames(item) }, 'итог не записан: у элемента нет связи со сделкой')
      return false
    }

    const description = buildAnswerComment(template, answers, score)
    if (description === '') {
      logger.warn({}, 'итог не записан: из ответов нечего собрать')
      return false
    }

    // ⚠ Инвариант проекта: перед созданием — поиск существующего. Источник правды о том,
    // писали мы уже или нет, — сам портал, а не таблица у нас.
    const find = buildFindActivityCall(activityOriginId(itemId))
    if (readFoundActivityId(await call(find.method, find.params)) !== null) {
      logger.info({}, 'итог уже записан делом, второго не создаём')
      return true
    }

    return await createMarkedActivity(call, {
      dealId,
      itemId,
      description,
      title: buildActivityTitle(template, score),
      color: hasBadSection(template, score) ? ACTIVITY_COLOR_BAD : ACTIVITY_COLOR_GOOD,
      responsibleId: readAssignedById(item),
    })
  }
  catch (error) {
    logger.warn({ reason: safeRefusal(error) }, 'дело с итогом не записано; ответ в портале')
    return false
  }
}

/**
 * Создать дело и сделать его находимым.
 *
 * ⚠ Два вызова, и это навязано, а не выбрано: `crm.activity.todo.add` метку не принимает,
 * `DESCRIPTION_TYPE` — тоже. Между ними есть окно, в котором дело существует БЕЗ метки:
 * остановись мы там, поиск его больше никогда не нашёл бы, а следующая запись создала бы
 * второе. Поэтому неудачная пометка КОМПЕНСИРУЕТСЯ — дело снимается.
 *
 * ⚠ Чего это окно не закрывает: жёсткая смерть процесса между созданием и удалением.
 * Останется одно ненаходимое дело. Закрыть это с нашей стороны нечем — нужен был бы
 * атомарный «создать с меткой», которого у этого типа дел нет. Цена ограничена одним делом
 * на падение, а не на ответ.
 */
async function createMarkedActivity(
  call: RestCall,
  plan: { dealId: number, itemId: number, title: string, description: string, color: string, responsibleId: number },
): Promise<boolean> {
  const add = buildTodoActivityCall({
    dealEntityTypeId: DEAL_ENTITY_TYPE_ID,
    dealId: plan.dealId,
    title: plan.title,
    description: plan.description,
    deadline: activityDeadline(new Date()),
    color: plan.color,
    ...(plan.responsibleId ? { responsibleId: plan.responsibleId } : {}),
  })
  const activityId = readCreatedActivityId(await call(add.method, add.params))
  if (activityId === null) {
    logger.warn({}, 'итог не записан: портал не вернул идентификатор дела')
    return false
  }

  const originId = activityOriginId(plan.itemId)
  const mark = buildActivityMarkerCall(activityId, originId)
  try {
    if (!readMarkApplied(await call(mark.method, mark.params))) {
      // ⚠ Двухсотый ответ с `false` — задокументированный путь отказа этого метода.
      // Приняв его за успех, мы оставили бы дело без метки: поиск не найдёт его никогда,
      // а следующая доставка создаст второе. Нашла панель ревью.
      throw new Error('портал не подтвердил пометку дела')
    }
  }
  catch (error) {
    await deleteOrphanActivity(call, activityId, originId)
    throw error
  }

  logger.info({}, 'итог опроса записан делом в таймлайн сделки')
  return true
}

/**
 * Снять дело, которое не удалось пометить.
 *
 * ⚠ СНАЧАЛА ПЕРЕСПРАШИВАЕМ ПОРТАЛ. Исключение из пометки означает «мы не дождались ответа»,
 * а не «портал ничего не сделал»: наш собственный таймаут и обрыв сети выглядят точно так же,
 * при том что запрос мог дойти и примениться. Удалив вслепую, мы снесли бы правильно
 * помеченное дело — то единственное уведомление, ради которого всё и затевалось, — молча
 * и без второй попытки: строка буфера к этому моменту уже удалена. Нашла панель ревью.
 *
 * Цена — один читающий вызов, и только на пути отказа.
 *
 * ⚠ Само удаление — по возможности: если не удалось и оно, наверх уходит ИСХОДНАЯ ошибка,
 * она объясняет, что случилось, — а про оставшееся дело предупреждает эта строка.
 */
async function deleteOrphanActivity(call: RestCall, activityId: string, originId: string): Promise<void> {
  try {
    const find = buildFindActivityCall(originId)
    if (readFoundActivityId(await call(find.method, find.params)) !== null) {
      logger.warn({}, 'пометка дела не подтвердилась, но дело нашлось по метке — оставляем как есть')
      return
    }

    const remove = buildDeleteActivityCall(activityId)
    await call(remove.method, remove.params)
  }
  catch (error) {
    logger.error(
      { reason: safeRefusal(error) },
      'непомеченное дело не удалось снять: в сделке останется запись, которую поиск не найдёт',
    )
  }
}

/**
 * Забыть ответ.
 *
 * ⚠ Именно удалить, а не пометить доставленным. Инвариант звучит «ни один ответ клиента
 * не хранится у нас дольше, чем нужно для доставки в портал», и `status = 'delivered'`
 * с сохранённым телом — это ровно то хранение, которого он запрещает. Источник истины —
 * портал; после успешной записи наша копия не нужна никому.
 */
async function forget(id: string): Promise<void> {
  await getDb().delete(schema.inbox).where(eq(schema.inbox.id, id))
}

/**
 * Вернуть строку в очередь или сдаться.
 *
 * ⚠ `reason` сюда приходит уже пропущенным через `safeRefusal` либо составленным нами —
 * то есть в нём по построению нет ничего из ответа клиента. Это важно вдвойне: строка пишется
 * не только в журнал, но и в колонку `inbox.last_error`, которая переживёт саму строку
 * в бэкапах. Обрезка оставлена как страховка от длины, а не как защита от содержимого:
 * защищать обрезкой то, что нельзя показывать, — это показывать первые пятьсот символов.
 */
async function release(row: BufferedAnswer, reason: string, exhausted: boolean): Promise<void> {
  const attempts = row.attempts + 1
  await getDb()
    .update(schema.inbox)
    .set({
      status: exhausted ? 'failed' : 'pending',
      attempts,
      lastError: reason.slice(0, 500),
      nextAttemptAt: new Date(Date.now() + backoffMinutes(attempts) * 60_000),
    })
    .where(eq(schema.inbox.id, row.id))

  logger[exhausted ? 'error' : 'warn'](
    { attempts, reason },
    exhausted ? 'ответ не доставлен: попытки исчерпаны, строка ждёт человека' : 'доставка ответа отложена',
  )
}

/**
 * Вернуть в работу строки, застрявшие в `sending`.
 *
 * Процесс мог умереть между «взял» и «доставил»: строка осталась помеченной, и её больше
 * никто не возьмёт. Без этого один перезапуск в неудачный момент тихо теряет ответ —
 * тихо, потому что в буфере он есть, а в портал не поедет никогда.
 */
export async function requeueStuck(olderThanMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const rows = await getDb()
    .update(schema.inbox)
    .set({ status: 'pending', nextAttemptAt: new Date() })
    // ⚠ Смотрим на `next_attempt_at`, который ставится в момент ЗАХВАТА, а не на
    // `received_at`. Сначала здесь стояло второе — и это был дефект с прямой ценой: ответ,
    // пролежавший в буфере дольше срока (портал был недоступен), возвращался бы в работу
    // через секунду после того, как его взяли, и уехал бы в портал дважды. То есть чинилка
    // потери ответа сама создавала бы дубли ровно в том сценарии, ради которого написана.
    .where(and(eq(schema.inbox.status, 'sending'), lt(schema.inbox.nextAttemptAt, cutoff)))
    .returning({ id: schema.inbox.id })

  if (rows.length > 0) logger.warn({ count: rows.length }, 'подвисшие ответы возвращены в буфер')
  return rows.length
}

/**
 * Стереть ответы, сдавшиеся дольше отсрочки.
 *
 * ⚠ РЕШЕНИЕ ВЛАДЕЛЬЦА, А НЕ ДЕТАЛЬ РЕАЛИЗАЦИИ (issue #24). Молча удалить ответ человека —
 * плохо; хранить вечно — тоже: `failed` единственное состояние, в котором ответ клиента
 * живёт у нас дольше доставки, и без предельного срока исключение из инварианта «ни один
 * ответ не хранится дольше, чем нужно для доставки» становится бессрочным. Выбраны
 * тридцать суток и запись факта в журнал — 23.09.
 *
 * ⚠ Срок ОБЩИЙ с отсрочкой мёртвого портала, и это выбор, а не совпадение: один срок
 * на весь проект проще объяснить в политике конфиденциальности и не требует второй
 * константы, которую забудут поменять вместе с первой. Разъедутся политики — тогда
 * и разводить, а не заранее.
 *
 * ⚠ Считаем от `received_at`, а не от момента перехода в `failed`, которого мы не храним.
 * Это СТРОЖЕ: отсчёт идёт с получения ответа, то есть строка живёт у нас не дольше срока,
 * а ровно до него. Ошибка в безопасную сторону там, где речь о персональных данных.
 *
 * ⚠ Факт удаления пишется ПОСТРОЧНО и без содержимого: ДОМЕН портала, дата получения,
 * наш код отказа. Ни текста ответа, ни хеша токена. Это то, что спросят при разборе
 * «а куда делся ответ», и единственный способ на него ответить, ничего не храня.
 * Построчно, а не счётчиком, — потому что счётчик отвечает «сколько», а спрашивают «какой».
 * Домен, а не внутренний идентификатор: после удаления строки журнал — это всё, что осталось,
 * и `uuid` в нём не отвечает на вопрос без похода в базу. Нашёл `/code-review` в PR #53.
 *
 * ⚠ Предохранитель здесь — НЕ доля, а ЧАСТОТА. Первая редакция обосновывала отсутствие
 * предохранителя тем, что потолок за заход ограничивает ущерб «пятьюдесятью строками
 * в минуту», — и это было неправдой: частота тика задаётся `ANSWER_DELIVERY_INTERVAL`,
 * который принимает пять секунд, то есть двенадцать заходов в минуту и 864 тысячи строк
 * в сутки. Ровно та ловушка, которую `purgeDeadPortals` документирует как уже обжёгшую
 * соседа: «потолок за прогон не ограничивает ущерб, пока частота прогонов задаётся чужой
 * переменной». Поэтому уборка идёт не чаще раза в час — срок хранения меряется сутками,
 * минутная точность ему не нужна, а ущерб теперь ограничен по-настоящему.
 * Нашёл `/code-review` в PR #53.
 *
 * ⚠ Доли, как у `purgeDeadPortals`, здесь по-прежнему нет, и это осознанно: там доля флота
 * отличает исход клиентов от нашей поломки, здесь отличать нечего — строка попадает
 * под удаление, только пробыв `failed` тридцать суток.
 *
 * ⚠ `portalId` в параметрах — ДЛЯ ТЕСТА, и это единственный способ проверить необратимую
 * операцию, не рискуя чужими данными. Без него тест звал бы глобальную уборку, и запуск
 * `pnpm check` с боевым `DATABASE_URL` стёр бы ответы ЧУЖИХ порталов — тот самый дефект,
 * который `tests/db/inbox-claim.test.ts` описывает как уже случившийся однажды.
 * Приложение передаёт его пустым и убирает всё.
 */
export async function purgeExpiredAnswers(
  now: Date,
  options: { limit?: number, portalId?: string } = {},
): Promise<number> {
  const db = getDb()
  const limit = options.limit ?? 50

  const scope = and(
    // ⚠ `failed` в условии обязателен. Без него под удаление попало бы всё, что старше
    // срока, — включая `pending`, который ждёт недоступного портала, и `sending`,
    // который воркер держит прямо сейчас.
    eq(schema.inbox.status, 'failed'),
    lt(schema.inbox.receivedAt, purgeBoundary(now)),
    ...(options.portalId === undefined ? [] : [eq(schema.inbox.portalId, options.portalId)]),
  )

  // ⚠ ПОТОЛОК ЗА ЗАХОД ОБЯЗАТЕЛЕН, и он же причина подзапроса: у `delete` в Postgres
  // нет `limit`, поэтому строки сначала отбираются, а потом удаляются по идентификаторам.
  // Без потолка одна ошибка в часах или в границе унесла бы весь буфер ОДНИМ запросом.
  // Порядок по дате получения: упёршись в потолок, стираем самые давние, а не случайные.
  const due = db.select({ id: schema.inbox.id }).from(schema.inbox).where(scope)
    .orderBy(schema.inbox.receivedAt)
    .limit(limit)

  const rows = await db
    .delete(schema.inbox)
    // ⚠ Условие ПОВТОРЕНО в самом `delete`, а не оставлено только в подзапросе. Список
    // идентификаторов вычисляется один раз, и строка, успевшая за это время уйти из `failed`
    // (оператор нажал `make prod-retry`, воркер её забрал), была бы удалена по устаревшему
    // списку — то есть у живой доставки из-под рук. Повтор стоит ноль и закрывает гонку.
    // Нашёл `/code-review` в PR #53.
    .where(and(eq(schema.inbox.status, 'failed'), inArray(schema.inbox.id, due)))
    .returning({
      id: schema.inbox.id,
      portalId: schema.inbox.portalId,
      receivedAt: schema.inbox.receivedAt,
      lastError: schema.inbox.lastError,
    })

  if (rows.length === 0) return 0

  // Домен берётся одним запросом на всю пачку, а не по строке на каждую.
  const domains = new Map(
    (await db
      .select({ id: schema.portals.id, domain: schema.portals.domain })
      .from(schema.portals)
      .where(inArray(schema.portals.id, [...new Set(rows.map(row => row.portalId))])))
      .map(row => [row.id, row.domain]),
  )

  for (const row of rows) {
    logger.warn(
      {
        domain: domains.get(row.portalId) ?? 'портал уже удалён',
        receivedAt: row.receivedAt.toISOString(),
        reason: row.lastError ?? 'неизвестно',
      },
      'ответ стёрт по истечении срока хранения, так и не доехав в портал',
    )
  }

  return rows.length
}

/** Сколько ответов ждёт доставки и сколько сдалось — для `/api/health`. */
export async function inboxDepth(): Promise<{ pending: number, failed: number }> {
  const rows = await getDb()
    .select({ status: schema.inbox.status, count: sql<number>`count(*)::int` })
    .from(schema.inbox)
    .groupBy(schema.inbox.status)

  const by = new Map(rows.map(row => [row.status, row.count]))
  return {
    pending: (by.get('pending') ?? 0) + (by.get('sending') ?? 0),
    failed: by.get('failed') ?? 0,
  }
}

/** Разобрать тело буфера. Форму кладёт `saveAnswer`, но читаем мы её как чужую. */
export function readAnswers(payload: unknown): Record<string, AnswerValue> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const bag = (payload as { answers?: unknown }).answers
  if (bag === null || bag === undefined || typeof bag !== 'object' || Array.isArray(bag)) return null

  const answers: Record<string, AnswerValue> = {}
  for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
    if (value === null || typeof value === 'number' || typeof value === 'string') answers[key] = value
    // Всё остальное молча выбросить нельзя: это значит записать неполный ответ под видом
    // полного. Лучше не разобрать целиком и оставить строку человеку.
    else return null
  }
  return answers
}
