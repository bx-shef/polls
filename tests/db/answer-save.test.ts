import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'
import { markOpened, saveAnswer } from '../../server/links/store'

/**
 * Транзакция приёма ответа (issue #17) — настоящим Postgres.
 *
 * ⚠ ЗДЕСЬ ЖИВЁТ САМЫЙ ДОРОГОЙ ИНВАРИАНТ ПРОЕКТА: «ответ клиента не теряется никогда».
 * `saveAnswer` одной транзакцией закрывает ссылку условным `UPDATE` по текущему статусу
 * и кладёт тело в буфер; `markOpened` защищён условием `WHERE status = 'sent'`. Оба —
 * compare-and-swap против гонки: два нажатия «Отправить» подряд, двойной клик по ссылке.
 *
 * ⚠ Юнит-тестом это не проверить В ПРИНЦИПЕ: поведение зависит от уровня изоляции
 * и блокировок строк, а не от нашего кода. Подделка базы подтвердит любой `where`.
 * Issue #17 называл это прямо: «если условие в UPDATE однажды потеряется при рефакторинге,
 * ни один тест этого не заметит, а ценой будет затёртый ответ клиента».
 *
 * Без `DATABASE_URL` файл пропускает себя сам.
 */

const enabled = isDatabaseConfigured()

/** Свой домен: чистим ТОЛЬКО его, а не таблицы — иначе прогон на боевой базе сотрёт чужое. */
const TEST_DOMAIN = 'db-answer-save.bitrix24.ru'

/** Текст ответа константой: сверяется потом ровно он, а не пересказ. */
const ANSWER_TEXT = 'ответ живого человека, который нельзя потерять'
const PERSON = 'Иванов Пётр Сергеевич'

let portalId: string

async function wipe() {
  await getDb().execute(sql`delete from ${schema.portals} where domain = ${TEST_DOMAIN}`)
}

/** Ссылка в рабочем состоянии плюс схема версии, без которой её не примет внешний ключ. */
async function seedLink(status = 'sent') {
  const tokenHash = randomUUID()
  const rows = await getDb()
    .insert(schema.linkIndex)
    .values({
      portalId,
      tokenHash,
      itemId: 54,
      surveyCode: 'brand',
      surveyVersion: 1,
      header: { company: 'ООО «Ромашка»', project: 'Бренд', respondent: PERSON, manager: PERSON },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status,
    })
    .returning({ id: schema.linkIndex.id })

  return { id: rows[0]!.id, portalId, status, tokenHash, surveyCode: 'brand', surveyVersion: 1 }
}

async function linkRow(id: string) {
  const rows = await getDb()
    .select({ status: schema.linkIndex.status, header: schema.linkIndex.header })
    .from(schema.linkIndex)
    .where(sql`${schema.linkIndex.id} = ${id}`)
  return rows[0]!
}

async function inboxRows() {
  return getDb()
    .select({ id: schema.inbox.id, payload: schema.inbox.payload })
    .from(schema.inbox)
    .where(sql`${schema.inbox.portalId} = ${portalId}`)
}

describe.skipIf(!enabled)('приём ответа', () => {
  beforeEach(async () => {
    await wipe()
    const rows = await getDb()
      .insert(schema.portals)
      .values({ memberId: randomUUID(), domain: TEST_DOMAIN })
      .returning({ id: schema.portals.id })
    portalId = rows[0]!.id

    await getDb().insert(schema.surveyTemplates).values({
      portalId,
      code: 'brand',
      version: 1,
      schema: { code: 'brand', title: 'Бренд-платформа', sections: [] },
    })
  })

  afterAll(async () => {
    if (!enabled) return
    await wipe()
  })

  it('кладёт ответ в буфер и закрывает ссылку', async () => {
    const link = await seedLink()

    expect(await saveAnswer(link, link.tokenHash, { answers: { q1: ANSWER_TEXT } })).toBe(true)

    expect((await linkRow(link.id)).status).toBe('completed')
    const buffered = await inboxRows()
    expect(buffered).toHaveLength(1)
    expect(JSON.stringify(buffered[0]!.payload)).toContain(ANSWER_TEXT)
  })

  it('ГЛАВНОЕ: второй ответ по той же ссылке не записывается и не сходит за успех', async () => {
    // ⚠ Два нажатия «Отправить» подряд — обычное дело, а не экзотика. Условие `WHERE status`
    // здесь и есть защита: без него второй ответ затёр бы первый, и потеря была бы
    // необратимой — в портал уехал бы не тот текст, а исходный исчез.
    const link = await seedLink()
    await saveAnswer(link, link.tokenHash, { answers: { q1: ANSWER_TEXT } })

    // Вызывающий держит ПРЕЖНЕЕ состояние ссылки: именно так выглядит повтор — страница
    // прочитала ссылку до первой отправки.
    expect(await saveAnswer(link, link.tokenHash, { answers: { q1: 'второй, лишний' } })).toBe(false)

    const buffered = await inboxRows()
    expect(buffered).toHaveLength(1)
    expect(JSON.stringify(buffered[0]!.payload)).toContain(ANSWER_TEXT)
    expect(JSON.stringify(buffered[0]!.payload)).not.toContain('второй, лишний')
  })

  it('отказ не оставляет за собой строку в буфере', async () => {
    // ⚠ Смысл транзакции: «закрыли ссылку» и «положили ответ» либо случаются вместе,
    // либо не случаются вовсе. Строка в буфере без закрытой ссылки — это второй ответ,
    // который воркер доставит как первый.
    const link = await seedLink('completed')

    expect(await saveAnswer({ ...link, status: 'sent' }, link.tokenHash, { answers: {} })).toBe(false)
    expect(await inboxRows()).toHaveLength(0)
  })

  it('уносит имена людей тем же запросом, которым закрывает ссылку', async () => {
    // ⚠ Отдельным запросом это можно забыть, а рассинхронизировать одну запись строки —
    // нечем. Шапку держат ровно затем, чтобы показать страницу; по закрытой ссылке
    // страница не открывается.
    const link = await seedLink()

    await saveAnswer(link, link.tokenHash, { answers: { q1: ANSWER_TEXT } })

    const after = await linkRow(link.id)
    expect(after.header).toBeNull()
    expect(JSON.stringify(after)).not.toContain(PERSON)
  })
})

describe.skipIf(!enabled)('отметка «ссылку открыли»', () => {
  beforeEach(async () => {
    await wipe()
    const rows = await getDb()
      .insert(schema.portals)
      .values({ memberId: randomUUID(), domain: TEST_DOMAIN })
      .returning({ id: schema.portals.id })
    portalId = rows[0]!.id

    await getDb().insert(schema.surveyTemplates).values({
      portalId,
      code: 'brand',
      version: 1,
      schema: { code: 'brand', title: 'Бренд-платформа', sections: [] },
    })
  })

  afterAll(async () => {
    if (!enabled) return
    await wipe()
  })

  it('переводит отправленную в «открыта»', async () => {
    const link = await seedLink()

    await markOpened(link.id)

    expect((await linkRow(link.id)).status).toBe('opened')
  })

  it('ГЛАВНОЕ: не воскрешает пройденную', async () => {
    // ⚠ Двойной клик по ссылке — и вторая вкладка отмечает «открыта» уже после того, как
    // в первой ответ отправлен. Без условия `WHERE status = 'sent'` ссылка вернулась бы
    // в рабочее состояние, и по ней приняли бы ВТОРОЙ ответ поверх записанного.
    const link = await seedLink('completed')

    await markOpened(link.id)

    expect((await linkRow(link.id)).status).toBe('completed')
  })

  it('не воскрешает и отозванную', async () => {
    // Отзыв — единственный способ остановить ссылку. Сняв его открытием страницы,
    // мы сделали бы кнопку «Отозвать» декорацией.
    const link = await seedLink('revoked')

    await markOpened(link.id)

    expect((await linkRow(link.id)).status).toBe('revoked')
  })
})
