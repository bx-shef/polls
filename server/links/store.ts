import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '../db/client'
import type { LinkStatus } from '../domain/links/access'
import type { SurveyTemplate } from '../domain/surveys/model'

/**
 * Everything the public survey page needs to read and write, in one place.
 *
 * Роут не ходит в базу сам: иначе знание о схеме размажется по обработчикам, и первая же
 * правка таблицы найдётся в трёх местах из четырёх. Здесь же видно целиком, что публичная
 * страница вообще трогает, — а трогает она немного и намеренно.
 */

/** Ссылка вместе с тем, что нужно, чтобы показать анкету. */
export interface StoredLink {
  id: string
  portalId: string
  status: LinkStatus
  expiresAt: Date
  surveyCode: string
  surveyVersion: number
  itemId: number
}

/**
 * Найти ссылку по хешу токена.
 *
 * ⚠ Ищем по хешу, а не по токену: самого токена в базе нет и не будет. Колонка уникальна,
 * поэтому это одна запись или ничего.
 */
export async function findLinkByTokenHash(tokenHash: string): Promise<StoredLink | null> {
  const rows = await getDb()
    .select({
      id: schema.linkIndex.id,
      portalId: schema.linkIndex.portalId,
      status: schema.linkIndex.status,
      expiresAt: schema.linkIndex.expiresAt,
      surveyCode: schema.linkIndex.surveyCode,
      surveyVersion: schema.linkIndex.surveyVersion,
      itemId: schema.linkIndex.itemId,
    })
    .from(schema.linkIndex)
    .where(eq(schema.linkIndex.tokenHash, tokenHash))
    .limit(1)

  const row = rows[0]
  if (row === undefined) return null
  return { ...row, status: row.status as LinkStatus }
}

/**
 * Прочитать схему анкеты из кэша версий.
 *
 * Портала здесь нет и быть не может: публичная страница о REST не знает. Кэш заполняется
 * при выпуске ссылки, то есть заведомо раньше, чем понадобится; промах означает не «сходи
 * в портал», а «эту ссылку выпустили неправильно».
 */
export async function findTemplate(portalId: string, code: string, version: number): Promise<SurveyTemplate | null> {
  const rows = await getDb()
    .select({ schema: schema.surveyTemplates.schema })
    .from(schema.surveyTemplates)
    .where(and(
      eq(schema.surveyTemplates.portalId, portalId),
      eq(schema.surveyTemplates.code, code),
      eq(schema.surveyTemplates.version, version),
    ))
    .limit(1)

  const row = rows[0]
  return row === undefined ? null : row.schema as SurveyTemplate
}

/**
 * Отметить, что ссылку открыли.
 *
 * Условие по текущему статусу стоит в самом UPDATE, а не проверяется до него: два
 * одновременных открытия одной ссылки — обычное дело (человек кликнул дважды), и без
 * условия второй запрос перезаписал бы `completed` обратно в `opened`.
 */
export async function markOpened(linkId: string): Promise<void> {
  await getDb()
    .update(schema.linkIndex)
    .set({ status: 'opened' })
    .where(and(eq(schema.linkIndex.id, linkId), eq(schema.linkIndex.status, 'sent')))
}

/**
 * Сохранить ответ и закрыть ссылку — одной транзакцией.
 *
 * ⚠ Порядок и атомарность здесь и есть инвариант «ответ клиента не теряется никогда».
 * Сначала буфер, потом попытка записи в портал: `inbox` — это то, из чего воркер соберёт
 * запись, когда портал ответит. Если бы статус ссылки закрывался отдельным запросом,
 * между ними нашлось бы окно, в котором ответ принят, а ссылка ещё рабочая — и второй
 * ответ затёр бы первый.
 *
 * Возвращает `false`, если ссылка уже не в рабочем состоянии: значит повторная отправка,
 * и её надо отбить, а не записать вторым ответом.
 */
export async function saveAnswer(link: StoredLink, tokenHash: string, payload: unknown): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const closed = await tx
      .update(schema.linkIndex)
      .set({ status: 'completed' })
      .where(and(
        eq(schema.linkIndex.id, link.id),
        // Только из рабочих состояний: повторная отправка по уже закрытой ссылке
        // не должна ни записаться, ни сойти за успех.
        eq(schema.linkIndex.status, link.status),
      ))
      .returning({ id: schema.linkIndex.id })

    if (closed.length === 0) return false

    await tx.insert(schema.inbox).values({
      portalId: link.portalId,
      tokenHash,
      payload: payload as object,
    })
    return true
  })
}
