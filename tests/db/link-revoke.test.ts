import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'
import { revokeLink } from '../../server/links/issue'
import { decideLinkAccess } from '../../server/domain/links/access'

/**
 * Отзыв выпущенной ссылки (issue #20) — настоящим Postgres.
 *
 * ⚠ ПОЧЕМУ НЕ ПОДДЕЛКОЙ. Здесь проверяется не форма запроса, а что именно изменилось
 * в таблице: погашена ли строка, уцелела ли чужая, исчезли ли имена людей. Мок подтвердил бы
 * любой `where`, а цена ошибки — либо неотзываемая ссылка (то есть отзыв, которого нет),
 * либо погашенная чужая. Ровно та причина, по которой в проекте вообще появился
 * третий проект `vitest`.
 *
 * Без `DATABASE_URL` файл пропускает себя сам.
 */

const enabled = isDatabaseConfigured()

/** Свой домен: чистим ТОЛЬКО его, а не таблицу — иначе прогон на боевой базе сотрёт чужое. */
const TEST_DOMAIN = 'db-revoke-test.bitrix24.ru'
const OTHER_DOMAIN = 'db-revoke-other.bitrix24.ru'

/** Имена в шапке — единственные персональные данные в нашей схеме; они и проверяются. */
const PERSON = 'Иванов Пётр Сергеевич'

let portalId: string
let otherPortalId: string

async function seed(portal: string, itemId: number, status = 'sent'): Promise<string> {
  const rows = await getDb()
    .insert(schema.linkIndex)
    .values({
      portalId: portal,
      tokenHash: randomUUID(),
      itemId,
      surveyCode: 'brand',
      surveyVersion: 1,
      header: { company: 'ООО «Ромашка»', project: 'Бренд', respondent: PERSON, manager: PERSON },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status,
    })
    .returning({ id: schema.linkIndex.id })
  return rows[0]!.id
}

async function row(id: string) {
  const rows = await getDb()
    .select({ status: schema.linkIndex.status, header: schema.linkIndex.header })
    .from(schema.linkIndex)
    .where(sql`${schema.linkIndex.id} = ${id}`)
  return rows[0]!
}

async function wipe() {
  await getDb().execute(sql`delete from ${schema.portals} where domain in (${TEST_DOMAIN}, ${OTHER_DOMAIN})`)
}

async function makePortal(domain: string): Promise<string> {
  const rows = await getDb()
    .insert(schema.portals)
    .values({ memberId: randomUUID(), domain })
    .returning({ id: schema.portals.id })
  return rows[0]!.id
}

describe.skipIf(!enabled)('отзыв ссылки', () => {
  beforeEach(async () => {
    await wipe()
    portalId = await makePortal(TEST_DOMAIN)
    otherPortalId = await makePortal(OTHER_DOMAIN)
  })

  afterAll(async () => {
    if (!enabled) return
    await wipe()
  })

  it('гасит ссылку и закрывает по ней страницу', async () => {
    // ⚠ Вторая половина утверждения и есть смысл отзыва. Состояние на портале видит менеджер,
    // а страницу закрывает НАША строка: публичная страница в портал не ходит по инварианту.
    const id = await seed(portalId, 54)

    expect(await revokeLink(portalId, 54)).toBe(1)

    const after = await row(id)
    expect(after.status).toBe('revoked')
    expect(decideLinkAccess(
      { status: 'revoked', expiresAt: new Date(Date.now() + 1000), surveyCode: 'brand', surveyVersion: 1 },
      new Date(),
    )).toEqual({ allow: false, reason: 'revoked' })
  })

  it('уносит имена людей вместе с отзывом', async () => {
    // ⚠ Снимок шапки держат ровно затем, чтобы показать страницу. Отозванная ссылка страницы
    // больше не покажет — значит хранить имена дальше нечем оправдать. То же правило уже
    // действует для пройденных и истёкших.
    const id = await seed(portalId, 54)

    await revokeLink(portalId, 54)

    const after = await row(id)
    expect(after.header).toBeNull()
    expect(JSON.stringify(after)).not.toContain(PERSON)
  })

  it('НЕ трогает ссылку другого портала с тем же номером элемента', async () => {
    // ⚠ Идентификаторы элементов выдаёт портал, и у разных порталов они совпадают постоянно.
    // Без условия по порталу сотрудник одного клиента гасил бы ссылку другого — молча.
    const ours = await seed(portalId, 54)
    const theirs = await seed(otherPortalId, 54)

    expect(await revokeLink(portalId, 54)).toBe(1)

    expect((await row(ours)).status).toBe('revoked')
    expect((await row(theirs)).status).toBe('sent')
    expect((await row(theirs)).header).not.toBeNull()
  })

  it('НЕ гасит пройденную: ответ клиента уже получен', async () => {
    // «Отозвано» задним числом означало бы, что ответа как будто не было.
    const id = await seed(portalId, 54, 'completed')

    expect(await revokeLink(portalId, 54)).toBe(0)
    expect((await row(id)).status).toBe('completed')
  })

  it('на несуществующую отвечает нулём, а не ошибкой', async () => {
    // Кнопку могли нажать на списке, который успел устареть. Это не повод падать.
    expect(await revokeLink(portalId, 999999)).toBe(0)
  })
})
