import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { callForPortal } from '../b24/from-record'
import { provisionWithCall } from '../b24/register'
import { getDb, schema } from '../db/client'
import { statusAfterProvision, stuckProvisioningBoundary } from '../domain/portals/lifecycle'
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
async function claimDegradedPortal(now: Date, portalId?: string): Promise<IssuingPortal | null> {
  const db = getDb()

  // Самый давний первым: портал, которому не везёт дольше всех, и ждёт дольше всех.
  const candidate = db
    .select({ id: schema.portals.id })
    .from(schema.portals)
    .where(and(
      eq(schema.portals.status, 'degraded'),
      isNull(schema.portals.grantRevokedAt),
      ...(portalId === undefined ? [] : [eq(schema.portals.id, portalId)]),
    ))
    .orderBy(schema.portals.updatedAt)
    .limit(1)

  const rows = await db
    .update(schema.portals)
    .set({ status: 'provisioning', updatedAt: now })
    .where(and(eq(schema.portals.status, 'degraded'), inArray(schema.portals.id, candidate)))
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
    const portal = await claimDegradedPortal(now, options.portalId)
    if (portal === null) break

    let outcome: 'ok' | 'not-admin' | 'no-scope' | 'failed'
    try {
      outcome = await provision(portal)
    }
    catch (error) {
      // ⚠ Исключение здесь — это НЕ повод оставить портал захваченным. Обустройство свои
      // отказы разбирает само и возвращает исходом; сюда доходит то, что оно не поймало,
      // и портал обязан вернуться в очередь, а не ждать возврата брошенных.
      logger.error({ domain: portal.domain, reason: (error as Error).message }, 'долечивание сорвалось')
      outcome = 'failed'
    }

    // ⚠ `expect: 'provisioning'` — compare-and-swap, и здесь он закрывает переустановку,
    // случившуюся ПОКА мы обустраивали. Она перезаписывает статус в `active` своими свежими
    // токенами, и записать поверх неё `degraded` по итогу устаревшей попытки значило бы
    // пометить сломанным портал, который только что встал заново.
    const status = statusAfterProvision(outcome)
    await applyProvisionStatus(portal.id, outcome, 'provisioning')

    if (status === 'active') {
      healed += 1
      logger.info({ domain: portal.domain }, 'портал долечен: обустройство прошло')
    }
    else {
      logger.error({ domain: portal.domain, outcome }, 'портал по-прежнему не обустроен')
    }
  }

  return healed
}
