import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'
import { forgetExpiredLinkHeaders } from '../../server/links/forget'

/**
 * Забывание имён у истёкших приглашений — настоящим Postgres.
 *
 * ⚠ ГВАРД ПОД НАХОДКУ ИНВЕНТАРИЗАЦИИ БАЗЫ 25.09 (issue #25). Дефект был не в пропущенной
 * ветке, а в НЕПРАВДЕ: и `schema.ts`, и `revokeLink` утверждали, что шапка приглашения —
 * единственное место в схеме, где лежат имена людей, — стирается «в конечном состоянии»,
 * и прямо называли истёкшие рядом с пройденными. На деле статус `expired` не выставлялся
 * никогда: истечение считалось на чтении. То есть приглашение, по которому никто не прошёл
 * (самый обычный исход опроса), держало имена клиента у нас вечно и переживало даже уход
 * клиента с приложения.
 *
 * ⚠ ПОЧЕМУ НЕ ПОДДЕЛКОЙ. Проверяется не форма запроса, а что именно осталось в таблице
 * после уборщика. Мок подтвердил бы любой `where`; здесь же цена ошибки в обе стороны —
 * либо имена живут вечно, либо уборщик уносит шапку живой ссылки и гасит человеку анкету.
 *
 * Без `DATABASE_URL` файл пропускает себя сам.
 */

const enabled = isDatabaseConfigured()

/** Свой домен: чистим ТОЛЬКО его, а не таблицу — иначе прогон на боевой базе сотрёт чужое. */
const TEST_DOMAIN = 'db-forget-test.bitrix24.ru'
const OTHER_DOMAIN = 'db-forget-other.bitrix24.ru'

/** Имена в шапке — то самое, что проверяется. */
const PERSON = 'Иванов Пётр Сергеевич'

const DAY = 24 * 60 * 60 * 1000

let portalId: string
let otherPortalId: string

/** Схема версии кладётся раньше ссылки — этого требует внешний ключ `link_index_template_fk`. */
async function seedTemplate(portal: string): Promise<void> {
  await getDb().insert(schema.surveyTemplates).values({
    portalId: portal,
    code: 'brand',
    version: 1,
    schema: { code: 'brand', title: 'Бренд-платформа', sections: [] },
  })
}

async function seed(portal: string, expiresAt: Date, status = 'sent'): Promise<string> {
  const rows = await getDb()
    .insert(schema.linkIndex)
    .values({
      portalId: portal,
      tokenHash: randomUUID(),
      itemId: Math.floor(Math.random() * 1_000_000),
      surveyCode: 'brand',
      surveyVersion: 1,
      header: { company: 'ООО «Ромашка»', project: 'Бренд', respondent: PERSON, manager: PERSON },
      expiresAt,
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

describe.skipIf(!enabled)('забывание истёкших приглашений', () => {
  beforeEach(async () => {
    await wipe()
    portalId = await makePortal(TEST_DOMAIN)
    otherPortalId = await makePortal(OTHER_DOMAIN)
    await seedTemplate(portalId)
    await seedTemplate(otherPortalId)
  })

  afterAll(async () => {
    if (!enabled) return
    await wipe()
  })

  it('ГЛАВНОЕ: у истёкшего приглашения не остаётся имён', async () => {
    // ⚠ Тот самый случай, который был открыт: ссылку выпустили, человек не ответил, срок
    // вышел. Показывать страницу больше некому — значит и держать имена нечем оправдать.
    const id = await seed(portalId, new Date(Date.now() - DAY))

    expect(await forgetExpiredLinkHeaders(new Date(), { portalId })).toBe(1)

    const after = await row(id)
    expect(after.header).toBeNull()
    expect(JSON.stringify(after)).not.toContain(PERSON)
  })

  it('и строка честно говорит, что истекла', async () => {
    // ⚠ Статус `expired` не выставлялся НИКОГДА: истечение считалось на чтении. Строка,
    // которая помнит «отправлено» через год после срока, врёт каждому, кто на неё посмотрит.
    const id = await seed(portalId, new Date(Date.now() - DAY))

    await forgetExpiredLinkHeaders(new Date(), { portalId })

    expect((await row(id)).status).toBe('expired')
  })

  it('живую ссылку НЕ трогает', async () => {
    // Обратная цена ошибки: унеся шапку живой ссылки, мы гасим человеку анкету, которую
    // ему прямо сейчас показывают.
    const id = await seed(portalId, new Date(Date.now() + DAY))

    expect(await forgetExpiredLinkHeaders(new Date(), { portalId })).toBe(0)

    const after = await row(id)
    expect(after.header).not.toBeNull()
    expect(after.status).toBe('sent')
  })

  it('пройденную НЕ переписывает на «истекла»', async () => {
    // ⚠ «Истекла» задним числом стёрло бы след того, что человек ответил. `revokeLink`
    // отказывается гасить пройденную по той же причине. Шапки у неё и так нет — её уносит
    // тот же `UPDATE`, что ставит статус, — но условие стоит явно: цена ошибок несимметрична.
    const id = await seed(portalId, new Date(Date.now() - DAY), 'completed')

    expect(await forgetExpiredLinkHeaders(new Date(), { portalId })).toBe(0)

    expect((await row(id)).status).toBe('completed')
  })

  it('НЕ трогает истёкшие ссылки другого портала', async () => {
    // ⚠ Здесь это не про изоляцию клиентов, а про сам `pnpm check`: без условия по порталу
    // прогон тестов с боевым `DATABASE_URL` стёр бы шапки чужих клиентов. Тот же приём,
    // что у `purgeExpiredAnswers`.
    const ours = await seed(portalId, new Date(Date.now() - DAY))
    const theirs = await seed(otherPortalId, new Date(Date.now() - DAY))

    expect(await forgetExpiredLinkHeaders(new Date(), { portalId })).toBe(1)

    expect((await row(ours)).header).toBeNull()
    expect((await row(theirs)).header).not.toBeNull()
  })

  it('за заход забывает не больше потолка, и начинает с самых давних', async () => {
    // ⚠ У `update` с подзапросом нет `limit`, а частота тика задаётся снаружи. Потолок —
    // единственное, что ограничивает ущерб от ошибки в границе.
    const oldest = await seed(portalId, new Date(Date.now() - 10 * DAY))
    const middle = await seed(portalId, new Date(Date.now() - 5 * DAY))
    const newest = await seed(portalId, new Date(Date.now() - DAY))

    expect(await forgetExpiredLinkHeaders(new Date(), { portalId, limit: 2 })).toBe(2)

    expect((await row(oldest)).header).toBeNull()
    expect((await row(middle)).header).toBeNull()
    expect((await row(newest)).header).not.toBeNull()
  })

  it('уже забытые строки НЕ съедают потолок', async () => {
    // ⚠ Этот гвард появился из обратной проверки: без него уборщик можно было сломать
    // незаметно. Условие «шапка ещё есть» стоит ДВАЖДЫ — в отборе и в самом `UPDATE`, —
    // и второе ловит гонку, а первое отвечает за то, чтобы отбор вообще брал работу.
    // Убери его — и на портале с тысячей давно забытых ссылок каждый заход выбирал бы
    // потолок уже пустых строк и не делал НИЧЕГО. Вечно, и при этом выглядя рабочим:
    // ровно та ловушка, которую проект ловил уже дважды.
    const forgotten = await seed(portalId, new Date(Date.now() - 10 * DAY))
    await forgetExpiredLinkHeaders(new Date(), { portalId })
    const fresh = await seed(portalId, new Date(Date.now() - DAY))

    expect(await forgetExpiredLinkHeaders(new Date(), { portalId, limit: 1 })).toBe(1)

    expect((await row(fresh)).header).toBeNull()
    expect((await row(forgotten)).header).toBeNull()
  })

  it('второй заход не делает ничего', async () => {
    // Доказывает, что уборщик отбирает по `header is not null`, а не по сроку: иначе он
    // переписывал бы одни и те же строки каждый час, вечно.
    await seed(portalId, new Date(Date.now() - DAY))

    expect(await forgetExpiredLinkHeaders(new Date(), { portalId })).toBe(1)
    expect(await forgetExpiredLinkHeaders(new Date(), { portalId })).toBe(0)
  })
})
