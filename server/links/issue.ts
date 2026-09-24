import { and, eq, ne } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import type { SurveyHeader } from '../domain/invitations/portal-calls'
import type { SurveyTemplate } from '../domain/surveys/model'

/**
 * Writes that happen when a link is issued.
 *
 * Отдельно от `store.ts`: тот обслуживает публичную страницу, а здесь пишет портал изнутри
 * своего iframe. Разные вызывающие, разные права, разный набор таблиц — держать это одним
 * файлом значит однажды позвать не ту функцию из не того места.
 */

/** Портал, от имени которого выпускается ссылка. */
export interface IssuingPortal {
  id: string
  memberId: string
  domain: string
  publicHost: string | null
  status: string
  accessToken: string | null
  refreshToken: string | null
  applicationToken: string | null
  tokenExpiresAt: Date | null
  scopes: string[] | null
}

/** Найти портал по `member_id`. Домен берётся ОТСЮДА, а не из запроса, — см. `frame-auth.ts`. */
export async function findPortalByMemberId(memberId: string): Promise<IssuingPortal | null> {
  const rows = await getDb()
    .select({
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
    })
    .from(schema.portals)
    .where(eq(schema.portals.memberId, memberId.toLowerCase()))
    .limit(1)

  return rows[0] ?? null
}

/**
 * Найти портал по нашему идентификатору.
 *
 * Отдельно от поиска по `member_id`: тот обслуживает запрос из фрейма, где `member_id`
 * единственное, что известно. Воркер доставки приходит от строки буфера, у которой уже
 * есть внешний ключ, и лишний поиск по чужому ключу тут был бы только способом ошибиться.
 */
export async function findPortalById(id: string): Promise<IssuingPortal | null> {
  const rows = await getDb()
    .select({
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
    })
    .from(schema.portals)
    .where(eq(schema.portals.id, id))
    .limit(1)

  return rows[0] ?? null
}

/**
 * Положить схему версии в кэш.
 *
 * ⚠ Вставка ИДЕМПОТЕНТНАЯ. Уникальный индекс стоит по паре «портал + код + версия», и вторая
 * ссылка на ту же версию — обычное дело: рассылка по кампании выпускает их десятками. Без
 * `ON CONFLICT DO NOTHING` вторая упала бы по конфликту, и выпуск сломался бы ровно тогда,
 * когда им начали пользоваться.
 *
 * Перезаписывать не нужно и нельзя: опубликованная версия неизменяема, значит расхождения
 * между тем, что лежит, и тем, что пришло, быть не может. А если оно вдруг появилось,
 * победить должна та схема, которую уже видели по выданным ссылкам.
 */
export async function cacheTemplate(
  portalId: string,
  code: string,
  version: number,
  template: SurveyTemplate,
): Promise<void> {
  await getDb()
    .insert(schema.surveyTemplates)
    .values({ portalId, code, version, schema: template })
    .onConflictDoNothing({
      target: [schema.surveyTemplates.portalId, schema.surveyTemplates.code, schema.surveyTemplates.version],
    })
}

/**
 * Записать выпущенную ссылку.
 *
 * ⚠ В базу уходит ХЕШ токена, сам токен сюда не передаётся вовсе — это видно из сигнатуры,
 * и так и задумано: в хранилище только хеш, инвариант проекта.
 */
export async function insertLink(link: {
  portalId: string
  tokenHash: string
  itemId: number
  surveyCode: string
  surveyVersion: number
  expiresAt: Date
  /** Шапка анкеты снимком. Пусто — портал её не отдал; страница обойдётся без неё. */
  header?: SurveyHeader
}): Promise<void> {
  await getDb().insert(schema.linkIndex).values({
    portalId: link.portalId,
    tokenHash: link.tokenHash,
    itemId: link.itemId,
    surveyCode: link.surveyCode,
    surveyVersion: link.surveyVersion,
    expiresAt: link.expiresAt,
    header: link.header ?? null,
    // Сразу `sent`, а не `created`: ссылку отдают человеку в тот же момент, когда выпускают.
    // Состояние `created` живёт для выпуска пачкой, где между выпуском и отправкой есть зазор.
    status: 'sent',
  })
}

/**
 * Сохранить обновлённые токены портала.
 *
 * ⚠ Только UPDATE и только по живому порталу — воскрешать стёртый нельзя. Между чтением
 * пары и записью новой стоит POST к серверу авторизации Битрикс24, то есть секунды; если
 * за это время портал стёрли как мёртвый, `INSERT`-ветка вернула бы его к жизни с рабочими
 * токенами клиента, который ушёл. Условие `status <> 'deleted'` закрывает это без блокировок:
 * обновлять нечего. Приём у соседа (`updatePortalTokenSecrets`), там он оплачен гонкой.
 *
 * ⚠ Отметка мёртвого гранта снимается ЗДЕСЬ ЖЕ, одним запросом, а не соседним. Успешное
 * продление и снятая отметка обязаны быть одной записью строки: отдельный запрос можно
 * забыть, а рассинхронизировать — нечем.
 */
export async function saveRefreshedTokens(
  portalId: string,
  tokens: { accessToken: string, refreshToken: string, expiresAt: Date, previousRefreshToken: string },
): Promise<void> {
  await getDb()
    .update(schema.portals)
    .set({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
      grantRevokedAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.portals.id, portalId),
      ne(schema.portals.status, 'deleted'),
      // ⚠ Пишем, только если в строке лежит ТА пара, с которой мы шли на обмен. Это
      // compare-and-swap, и он закрывает гонку: вкладка в карточке сделки делает два запроса
      // подряд, сотрудников на портале много, и два обработчика могут пойти обменивать
      // один и тот же протухший токен одновременно. Обмен ВРАЩАЕТ грант — пара проигравшего
      // мертва в момент, когда он её записывает. Без условия последний писатель клал
      // в базу мёртвый токен, и портал отвечал `expired_token` на всё до переустановки
      // приложения. Проигравший просто не пишет: его вызов доработает на своей паре,
      // а следующий перечитает строку и возьмёт пару победителя.
      eq(schema.portals.refreshToken, tokens.previousRefreshToken),
    ))
}
