import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { callForPortal } from '../b24/from-record'
import { readStoredRefs } from '../b24/provision'
import { provisionWithCall } from '../b24/register'
import { getDb, schema } from '../db/client'
import { statusAfterProvision, stuckProvisioningBoundary } from '../domain/portals/lifecycle'
import { PROVISION_REVISION } from '../domain/portals/smart-processes'
import type { IssuingPortal } from '../links/issue'
import { logger } from '../utils/logger'
import { applyProvisionStatus } from './store'

/**
 * Healing portals that were installed but never provisioned (issue #12).
 *
 * ⚠ ЧТО ЗДЕСЬ БЫЛО СЛОМАНО. Установка сохраняет токены первой и обустраивает портал вторым
 * шагом, не роняя установку при неудаче: второго события `ONAPPINSTALL` не будет, а токены —
 * то, без чего нельзя вообще ничего. Неудача переводила портал в `degraded`, и на этом всё
 * заканчивалось: статус не читала НИ ОДНА строка кода. Администратор видел установленное
 * приложение, которое молча не работает, и единственным выходом была переустановка руками —
 * о необходимости которой ему никто не говорил.
 *
 * ⚠ ОЧЕРЕДИ (BullMQ) ЗДЕСЬ НЕТ, хотя issue #12 просил именно её, — и это осознанное
 * отступление, а не упрощение по лени. Проект уже отказался от BullMQ в пользу тика внутри
 * процесса (`server/answers/deliver.ts`, разбор в шапке): у доставки ответов та же природа
 * работы, и своего брокера ей не нужно. Заводить очередь ради второго потребителя значило бы
 * притащить брокер, воркер-процесс и второй способ выполнять фоновую работу — при том, что
 * первый уже работает и проверен. Долечивание встаёт третьим уборщиком на существующий тик,
 * рядом с уборкой буфера и мёртвых порталов.
 *
 * ⚠ БЛОКИРОВКА ЕСТЬ, и её просил тот же issue. Она не на `member_id` в Redis, а в самой
 * таблице: статус `provisioning` — это и есть «портал взят в работу». Захват делается
 * ОДНИМ `UPDATE … WHERE status = 'degraded'`, то есть выигрывает ровно один исполнитель,
 * а проигравший получает ноль строк. Ровно тем же приёмом живёт буфер ответов
 * (`pending` → `sending`), включая возврат брошенного: см. `requeueStuckProvisioning`.
 * Приём заодно снимает допущение «установка приходит одним событием, значит выполняется
 * в один поток» из шапки обустройства.
 */

/** Что умеет делать с порталом тот, кто его лечит. Подделывается в тестах. */
export type ProvisionAttempt = (portal: IssuingPortal) => Promise<'ok' | 'not-admin' | 'no-scope' | 'failed'>

/** Колонки, которых хватает, чтобы собрать вызов портала. Тот же набор, что у `findPortalByMemberId`. */
const PORTAL_COLUMNS = {
  id: schema.portals.id,
  memberId: schema.portals.memberId,
  domain: schema.portals.domain,
  publicHost: schema.portals.publicHost,
  status: schema.portals.status,
  accessToken: schema.portals.accessToken,
  refreshToken: schema.portals.refreshToken,
  applicationToken: schema.portals.applicationToken,
  tokenExpiresAt: schema.portals.tokenExpiresAt,
  scopes: schema.portals.scopes,
}

/**
 * Вернуть в очередь порталы, брошенные на середине обустройства.
 *
 * ⚠ Без этого захват превращается в ловушку: процесс, умерший между «взял» и «записал исход»,
 * оставлял бы портал в `provisioning` навсегда, и лечить его было бы некому. Ровно тот же
 * дефект, ради которого у буфера ответов появился `requeueStuck`, — и то же лекарство.
 *
 * Возвращает, сколько вернули: ноль — обычное состояние.
 */
export async function requeueStuckProvisioning(now: Date): Promise<number> {
  const rows = await getDb()
    .update(schema.portals)
    .set({ status: 'degraded', updatedAt: now })
    .where(and(
      eq(schema.portals.status, 'provisioning'),
      lt(schema.portals.updatedAt, stuckProvisioningBoundary(now)),
    ))
    .returning({ domain: schema.portals.domain })

  for (const row of rows) {
    logger.warn({ domain: row.domain }, 'обустройство брошено на середине, портал возвращён в очередь')
  }
  return rows.length
}

/**
 * Взять один портал в работу.
 *
 * ⚠ ОДИН `UPDATE`, А НЕ «ПРОЧИТАЛ И ЗАПИСАЛ». Между «выбрал кандидата» и «записал захват»
 * помещается второй исполнитель, и если он тоже запишет — в чужой портал уедут два
 * обустройства разом, 34–38 вызовов вместо 17–19 под общим бюджетом в 45 секунд. Здесь
 * это одно предложение SQL: Postgres блокирует строку и после снятия блокировки перечитает
 * условие, так что проигравший получит ноль строк.
 *
 * ⚠ Условие `status = 'degraded'` продублировано — и в подзапросе, и в самом `UPDATE`. Честно
 * про это: обратной мутацией доказать необходимость дубля НЕ УДАЛОСЬ — снятие внешнего условия
 * не покраснело ни на последовательной гонке, ни на одновременной. Похоже, при повторной
 * проверке Postgres переисполняет и сам подзапрос, то есть защита там уже есть. Дубль оставлен
 * сознательно: он стоит ноль, а полагаться на подробности EvalPlanQual в вопросе «сколько раз
 * мы пойдём в чужой портал» не хочется. Записано здесь, чтобы следующий читатель не искал
 * гвард, которого нет.
 *
 * ⚠ Портал с мёртвым грантом НЕ берём. Его токены нам уже не обменивают — обустройство
 * упадёт на первом же вызове, и единственным следствием будет строка в журнале каждый час
 * до самого стирания.
 */
async function claimPortal(now: Date, from: string, portalId?: string): Promise<IssuingPortal | null> {
  const db = getDb()

  // Самый давний первым: портал, которому не везёт дольше всех, и ждёт дольше всех.
  const candidate = db
    .select({ id: schema.portals.id })
    .from(schema.portals)
    .where(and(
      eq(schema.portals.status, from),
      isNull(schema.portals.grantRevokedAt),
      ...(portalId === undefined ? [] : [eq(schema.portals.id, portalId)]),
    ))
    .orderBy(schema.portals.updatedAt)
    .limit(1)

  const rows = await db
    .update(schema.portals)
    .set({ status: 'provisioning', updatedAt: now })
    .where(and(eq(schema.portals.status, from), inArray(schema.portals.id, candidate)))
    .returning(PORTAL_COLUMNS)

  return rows[0] ?? null
}

/** Обустроить портал его же сохранёнными токенами. Ровно то, что делает кнопка «доустроить». */
const provisionStoredPortal: ProvisionAttempt = async (portal) => {
  const caller = callForPortal(portal)
  // Токенов нет или они не читаются — лечить нечем, и это НЕ отказ портала. Сообщение
  // пишет сам `callForPortal`; сюда возвращаем общий отказ, чтобы портал остался `degraded`.
  if (caller === null) return 'failed'
  return provisionWithCall(caller.call, portal.domain)
}

/**
 * Долечить порталы, застрявшие в `degraded`.
 *
 * ⚠ ПОВТОРЫ БЕСКОНЕЧНЫ, И СЧЁТЧИКА ПОПЫТОК НЕТ. Issue просил «повторы с разумной паузой»
 * и уведомление в канал проблем после их исчерпания — но канала проблем ещё не существует
 * (задача 11 из `DAY-ONE.md`), а исчерпание повторов без адресата означало бы, что портал
 * тихо перестаёт лечиться и больше об этом никто не узнаёт. Это хуже, чем строка в журнале
 * раз в час. Пауза — час, тот же замок времени, что у соседних уборщиков.
 *
 * ⚠ Каждая неудача пишется ОШИБКОЙ с доменом и исходом. Домен — не секрет и единственное,
 * по чему видно, у какого клиента приложение стоит и не работает.
 *
 * `portalId` в параметрах — для теста, как и у соседних уборщиков: он обязан уметь
 * ограничиться своим порталом, иначе прогон `pnpm check` с боевым `DATABASE_URL` полез бы
 * обустраивать чужие.
 *
 * Возвращает, сколько порталов вылечено.
 */
export async function healDegradedPortals(
  now: Date,
  options: { limit?: number, portalId?: string, provision?: ProvisionAttempt } = {},
): Promise<number> {
  const limit = options.limit ?? 5
  const provision = options.provision ?? provisionStoredPortal

  let healed = 0
  for (let taken = 0; taken < limit; taken += 1) {
    const portal = await claimPortal(now, 'degraded', options.portalId)
    if (portal === null) break
    if (await provisionClaimed(portal, provision, 'долечивание')) healed += 1
  }

  return healed
}

/**
 * Обустроить захваченный портал и отпустить его.
 *
 * ⚠ `expect: 'provisioning'` — compare-and-swap, и он закрывает переустановку, случившуюся
 * ПОКА мы обустраивали. Она перезаписывает статус в `active` своими свежими токенами, и
 * записать поверх неё `degraded` по итогу устаревшей попытки значило бы пометить сломанным
 * портал, который только что встал заново.
 */
async function provisionClaimed(
  portal: IssuingPortal,
  provision: ProvisionAttempt,
  what: string,
): Promise<boolean> {
  let outcome: 'ok' | 'not-admin' | 'no-scope' | 'failed'
  try {
    outcome = await provision(portal)
  }
  catch (error) {
    // ⚠ Исключение здесь — это НЕ повод оставить портал захваченным. Обустройство свои
    // отказы разбирает само и возвращает исходом; сюда доходит то, что оно не поймало,
    // и портал обязан вернуться в очередь, а не ждать возврата брошенных.
    logger.error({ domain: portal.domain, reason: (error as Error).message, what }, 'обустройство сорвалось')
    outcome = 'failed'
  }

  const status = statusAfterProvision(outcome)
  await applyProvisionStatus(portal.id, outcome, 'provisioning')

  if (status === 'active') {
    logger.info({ domain: portal.domain, what }, 'портал обустроен')
    return true
  }
  logger.error({ domain: portal.domain, outcome, what }, 'портал по-прежнему не обустроен')
  return false
}

/**
 * Донастроить порталы, обустроенные ПРОШЛОЙ ревизией (issue #75).
 *
 * ⚠ Зачем вообще. Всё, что настраивает портал, делает обустройство, а зовут его только при
 * установке, по кнопке «доустроить» и при долечивании сломанного. Портал в статусе `active`
 * не обустраивался больше никогда — то есть вкладка, добавленная релизом, не появлялась
 * ни у одного уже установленного клиента, и заметить это было нечем.
 *
 * ⚠ Ревизия читается ДО захвата, отдельным дешёвым вызовом. Захватив сначала, мы отбирали бы
 * каждый активный портал у самого себя раз в час и возвращали бы его обратно — механизм
 * выглядел бы работающим и делал бы только шум в журнале.
 *
 * ⚠ Обустройство идемпотентно по построению: смарт-процессы ищутся перед созданием, поля
 * добавляются только недостающие, вкладка перерегистрируется. Это не новое свойство, которое
 * пришлось обеспечивать ради повторов, — оно было с первого дня и до сих пор не использовалось.
 *
 * Возвращает, сколько порталов донастроили.
 */
export async function refreshOutdatedPortals(
  now: Date,
  options: {
    limit?: number
    portalId?: string
    provision?: ProvisionAttempt
    readRevision?: (portal: IssuingPortal) => Promise<number>
  } = {},
): Promise<number> {
  const limit = options.limit ?? 5
  const provision = options.provision ?? provisionStoredPortal
  const readRevision = options.readRevision ?? readPortalRevision

  const active = await getDb()
    .select(PORTAL_COLUMNS)
    .from(schema.portals)
    .where(and(
      eq(schema.portals.status, 'active'),
      isNull(schema.portals.grantRevokedAt),
      ...(options.portalId === undefined ? [] : [eq(schema.portals.id, options.portalId)]),
    ))
    .orderBy(schema.portals.updatedAt)
    .limit(limit)

  let refreshed = 0
  for (const candidate of active) {
    let revision: number
    try {
      revision = await readRevision(candidate)
    }
    catch (error) {
      // Портал не ответил — не повод считать его устаревшим и идти его настраивать.
      logger.warn({ domain: candidate.domain, reason: (error as Error).message }, 'ревизия обустройства не прочитана')
      continue
    }
    if (revision >= PROVISION_REVISION) continue

    // Захват тем же приёмом, что у долечивания: `active` → `provisioning` одним `UPDATE`.
    const portal = await claimPortal(now, 'active', candidate.id)
    if (portal === null) continue

    logger.warn({ domain: portal.domain, revision, needed: PROVISION_REVISION }, 'портал настроен прошлой ревизией')
    if (await provisionClaimed(portal, provision, 'донастройка')) refreshed += 1
  }

  return refreshed
}

/** Прочитать ревизию у портала его же сохранёнными токенами. */
async function readPortalRevision(portal: IssuingPortal): Promise<number> {
  const caller = callForPortal(portal)
  // Токенов нет или они не читаются — сообщение пишет сам `callForPortal`. Считать такой
  // портал устаревшим незачем: обустраивать его всё равно нечем.
  if (caller === null) return PROVISION_REVISION
  return (await readStoredRefs(caller.call)).revision
}
