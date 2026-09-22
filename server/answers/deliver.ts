import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { callForPortal } from '../b24/from-record'
import { readStoredRefs } from '../b24/provision'
import type { RestCall } from '../b24/provision'
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

    const call = callForPortal(portal)
    if (call === null) return { ok: false, retry: true, reason: 'у портала нет пригодных токенов' }

    return await writeToPortal(call, link.itemId, template, answers)
  }
  catch (error) {
    // ⚠ Наружу уходит НАШ код отказа, а не текст портала. Текст портала цитирует присланное
    // значение — а присланное значение здесь и есть ответ клиента. См. `portal-errors.ts`.
    // База сюда тоже попадает: её ошибка так же не должна утечь в журнал целиком.
    return { ok: false, retry: true, reason: safeRefusal(error) }
  }
}

export async function writeToPortal(
  call: RestCall,
  itemId: number,
  template: SurveyTemplate,
  answers: Record<string, AnswerValue>,
): Promise<DeliveryOutcome> {
  const refs = await readStoredRefs(call)
  if (refs.survey === undefined) {
    // Смарт-процессы создаются при установке; их отсутствие лечится переустановкой,
    // а не повтором. Но повторить стоит: установка могла идти прямо сейчас.
    return { ok: false, retry: true, reason: 'смарт-процесс «Опрос» не найден на портале' }
  }

  const score = scoreSurvey(template, answers)

  const update = buildCompleteSurveyCall(refs.survey, itemId, { answers, score, completedAt: new Date() })
  const updated = readUpdatedItemId(await call(update.method, update.params))
  if (updated === null) return { ok: false, retry: true, reason: 'портал не подтвердил обновление элемента' }

  // Дальше — только удобство. Всё, что было обязательным, уже в портале.
  const reported = await tryTimelineActivity(call, refs.survey, itemId, template, answers, score)
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
  survey: { entityTypeId: number, id: number },
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
