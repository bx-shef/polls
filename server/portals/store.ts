import { and, eq, isNull, lt, ne, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import { purgeBoundary } from '../domain/portals/lifecycle'
import { logger } from '../utils/logger'

/**
 * The portal's life after installation: the grant dies, and we erase what we held.
 *
 * ⚠ Все писатели здесь — ТОЛЬКО `UPDATE`, никаких `INSERT`. Приём взят у соседа
 * (`client-bank-alfa-by`, `updatePortalTokenSecrets`), где он закрыл целый класс гонок:
 * продление токена, начавшееся до стирания портала и закончившееся после, воскрешало
 * строку удалённого клиента с живыми токенами. Между чтением и записью там стоит POST
 * к серверу авторизации Битрикс24 — это секунды, и никакой перечиткой окно не закрыть.
 * `UPDATE`-only закрывает его целиком и без блокировок: стирать нечего — обновлять нечего.
 *
 * Законного случая, когда продление обязано СОЗДАТЬ запись, не существует: чтобы обменять
 * пару, её надо было сперва из этой записи прочитать.
 */

/**
 * Отметить, что портал отказал по мёртвому гранту.
 *
 * ⚠ `isNull(grantRevokedAt)` несущее: отсчёт идёт от ПЕРВОГО отказа. Переписывая отметку
 * на каждом тике, мы отодвигали бы срок вечно — уборщик выглядел бы рабочим и не работал
 * никогда. Это прямая цитата из разбора соседа, и ошибка там была настоящей.
 *
 * ⚠ `updatedAt` НЕ трогаем. Он означает «когда у нас была свежая пара», и сдвинув его,
 * мы соврали бы о возрасте токенов ровно в тот момент, когда их уже нет.
 */
export async function markGrantRevoked(portalId: string, at: Date): Promise<void> {
  const rows = await getDb()
    .update(schema.portals)
    .set({ grantRevokedAt: at })
    .where(and(
      eq(schema.portals.id, portalId),
      isNull(schema.portals.grantRevokedAt),
      // У стёртого портала отмечать нечего: он уже без токенов.
      ne(schema.portals.status, 'deleted'),
    ))
    .returning({ domain: schema.portals.domain })

  const hit = rows[0]
  if (hit !== undefined) {
    logger.warn({ domain: hit.domain }, 'портал отказал по мёртвому гранту, пошёл отсчёт до стирания')
  }
}

/**
 * Стереть у портала всё, что мы о нём держим, кроме самого факта.
 *
 * ⚠ Строка не удаляется, а обнуляется, и это осознанно. `inbox` и `link_index` ссылаются
 * на портал внешним ключом, и удаление строки либо каскадом унесло бы недоставленные ответы
 * живых людей, либо упёрлось бы в ограничение. Ценность несут ТОКЕНЫ — их и стираем,
 * вместе с правами и признаком лицензии. Остаётся `member_id` и домен: по ним портал
 * узнаётся при переустановке, и они же не дают повторно завести его второй строкой.
 *
 * ⚠ Идемпотентно и безопасно при повторе: условие `ne(status, 'deleted')` делает второй
 * вызов пустым, а не переписывающим.
 */
export async function purgePortalTokens(portalId: string, reason: 'grant-dead'): Promise<boolean> {
  const rows = await getDb()
    .update(schema.portals)
    .set({
      accessToken: null,
      refreshToken: null,
      applicationToken: null,
      tokenExpiresAt: null,
      scopes: null,
      license: null,
      status: 'deleted',
      updatedAt: new Date(),
    })
    .where(and(eq(schema.portals.id, portalId), ne(schema.portals.status, 'deleted')))
    .returning({ domain: schema.portals.domain })

  const hit = rows[0]
  if (hit === undefined) return false

  logger.warn({ domain: hit.domain, reason }, 'токены портала стёрты')
  return true
}

/**
 * Стереть все порталы, чей грант мёртв дольше отсрочки.
 *
 * ⚠ `limit` обязателен и приходит снаружи. Без него одна ошибка классификации однажды
 * унесла бы всех клиентов разом — а стереть можно только один раз. Сортировка по отметке:
 * при упоре в потолок стираются самые давние, а не случайные.
 *
 * Возвращает, сколько стёрли: ноль — обычное состояние, и его в журнал не пишем.
 */
export async function purgeDeadPortals(now: Date, limit = 20): Promise<number> {
  const due = await getDb()
    .select({ id: schema.portals.id })
    .from(schema.portals)
    .where(and(
      lt(schema.portals.grantRevokedAt, purgeBoundary(now)),
      ne(schema.portals.status, 'deleted'),
    ))
    .orderBy(schema.portals.grantRevokedAt)
    .limit(limit)

  let purged = 0
  for (const row of due) {
    if (await purgePortalTokens(row.id, 'grant-dead')) purged += 1
  }
  return purged
}

/**
 * Сколько порталов сейчас под отсчётом. Для `/api/health`: растущее число — единственный
 * снаружи видимый признак того, что клиенты уходят или что-то сломалось у нас.
 */
export async function countRevokedPortals(): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.portals)
    .where(and(
      sql`${schema.portals.grantRevokedAt} is not null`,
      ne(schema.portals.status, 'deleted'),
    ))
  return rows[0]?.n ?? 0
}
