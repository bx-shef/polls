import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'

/**
 * «Схема раньше ссылки» — теперь ограничение базы, а не порядок строк в обработчике (issue #21).
 *
 * ⚠ ЧТО ИМЕННО ЗДЕСЬ ДОРОГО. Публичная страница анкеты не ходит в портал ПО ИНВАРИАНТУ:
 * схему она берёт только из нашего кэша. Значит строка в `link_index` без строки
 * в `survey_templates` — это пожизненный 503 по ссылке, которая уже у человека в письме.
 * Отозвать её нельзя, перевыпустить — тоже (токен одноразовый и у нас только его хеш).
 *
 * До внешнего ключа порядок держался комментарием в шапке файла и вниманием того, кто файл
 * правит. Проверить это юнит-тестом нельзя в принципе: предмет проверки — поведение Postgres,
 * а не то, какой запрос мы собрали. Поэтому настоящая база, как и у соседних файлов здесь.
 *
 * Без `DATABASE_URL` файл пропускает себя сам.
 */

const enabled = isDatabaseConfigured()

/** Свой домен: чистим ТОЛЬКО его, а не таблицы — иначе прогон на боевой базе сотрёт чужое. */
const TEST_DOMAIN = 'db-fk-test.bitrix24.ru'

let portalId: string

async function wipe() {
  await getDb().execute(sql`delete from ${schema.portals} where domain = ${TEST_DOMAIN}`)
}

async function seedTemplate(code: string, version: number) {
  await getDb().insert(schema.surveyTemplates).values({
    portalId,
    code,
    version,
    schema: { code, title: 'Бренд-платформа', sections: [] },
  })
}

function insertLink(code: string, version: number) {
  return getDb().insert(schema.linkIndex).values({
    portalId,
    tokenHash: randomUUID(),
    itemId: 54,
    surveyCode: code,
    surveyVersion: version,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    status: 'sent',
  })
}

describe.skipIf(!enabled)('схема версии раньше ссылки', () => {
  beforeEach(async () => {
    await wipe()
    const rows = await getDb()
      .insert(schema.portals)
      .values({ memberId: randomUUID(), domain: TEST_DOMAIN })
      .returning({ id: schema.portals.id })
    portalId = rows[0]!.id
  })

  afterAll(async () => {
    if (!enabled) return
    await wipe()
  })

  it('ГЛАВНОЕ: ссылку без кэша схемы база не принимает', async () => {
    // ⚠ Ради этого утверждения задача и заводилась. Раньше такая строка вставлялась молча,
    // а узнавал об этом посторонний человек — пустой страницей по ссылке из письма.
    await expect(insertLink('brand', 1)).rejects.toThrow()
  })

  it('с кэшем схемы — принимает', async () => {
    // Обратная сторона: ключ не должен мешать нормальному выпуску.
    await seedTemplate('brand', 1)

    await expect(insertLink('brand', 1)).resolves.toBeDefined()
  })

  it('версия учитывается, а не только код', async () => {
    // ⚠ Опубликованная версия неизменяема, и ссылка выпускается на КОНКРЕТНУЮ. Схема первой
    // версии не годится второй: человек увидел бы другие формулировки вопросов, чем те,
    // на которые его звали. Ключ составной именно поэтому.
    await seedTemplate('brand', 1)

    await expect(insertLink('brand', 2)).rejects.toThrow()
  })

  it('чужая схема не годится: портал в ключе тоже есть', async () => {
    // Коды анкет у разных клиентов совпадают постоянно — «brand» есть у каждого второго.
    const others = await getDb()
      .insert(schema.portals)
      .values({ memberId: randomUUID(), domain: `other-${TEST_DOMAIN}` })
      .returning({ id: schema.portals.id })
    const otherPortal = others[0]!.id

    await getDb().insert(schema.surveyTemplates).values({
      portalId: otherPortal,
      code: 'brand',
      version: 1,
      schema: { code: 'brand', title: 'Чужая', sections: [] },
    })

    await expect(insertLink('brand', 1)).rejects.toThrow()

    await getDb().execute(sql`delete from ${schema.portals} where id = ${otherPortal}`)
  })

  it('схему живой ссылки не удалить', async () => {
    // ⚠ Обратная сторона ключа, и она принята сознательно (решение владельца, issue #21).
    // Чистки кэша у нас нет вовсе; когда появится, ей придётся считаться с этим ключом —
    // и это правильно: выбросить схему живой ссылки значит сломать её страницу.
    await seedTemplate('brand', 1)
    await insertLink('brand', 1)

    await expect(
      getDb().execute(sql`delete from ${schema.surveyTemplates} where portal_id = ${portalId} and code = 'brand'`),
    ).rejects.toThrow()
  })

  it('схему без ссылок — удалить можно', async () => {
    // Иначе кэш нельзя было бы чистить вообще, а это уже не защита, а ловушка.
    await seedTemplate('brand', 1)

    await expect(
      getDb().execute(sql`delete from ${schema.surveyTemplates} where portal_id = ${portalId} and code = 'brand'`),
    ).resolves.toBeDefined()
  })

  it('удаление портала уносит и схемы, и ссылки', async () => {
    // ⚠ Каскад по порталу обязан пережить новый ключ. Удаление портала — это уход клиента,
    // и упрись оно в ссылку, мы не смогли бы стереть его данные по первому же требованию.
    await seedTemplate('brand', 1)
    await insertLink('brand', 1)

    // Ключ не мешает: каскад по порталу уносит сначала ссылки, потом схемы.
    await wipe()

    const left = await getDb()
      .select({ id: schema.linkIndex.id })
      .from(schema.linkIndex)
      .where(sql`${schema.linkIndex.portalId} = ${portalId}`)
    expect(left).toEqual([])
  })
})
