import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'
import { saveRefreshedTokens } from '../../server/links/issue'
import { countRevokedPortals, markGrantRevoked, purgeDeadPortals, purgePortalTokens } from '../../server/portals/store'

/**
 * Жизнь портала после установки — против настоящего Postgres.
 *
 * Подделкой базы это не проверяется: здесь условные `UPDATE` (`WHERE grant_revoked_at IS NULL`,
 * `WHERE status <> 'deleted'`), и вся их ценность в том, скольких строк они НЕ касаются.
 * Мок подтвердил бы любую чушь.
 *
 * ⚠ Два инварианта, каждый из которых ломается тихо:
 *
 * 1. **Отметка ставится один раз.** Перепиши её каждый отказ — срок отодвигается вечно,
 *    уборщик не срабатывает никогда и при этом выглядит рабочим. Ровно эта ошибка разобрана
 *    у соседа (`client-bank-alfa-by`, `markGrantRevoked`).
 * 2. **Продление не воскрешает стёртый портал.** Между чтением пары и записью новой стоит
 *    POST к серверу авторизации — секунды; успей за них уборщик, `UPDATE` без условия вернул бы
 *    к жизни токены ушедшего клиента.
 *
 * Без `DATABASE_URL` файл пропускает себя сам: в CI базу поднимает сервис, локально — `make up`.
 */

const enabled = isDatabaseConfigured()
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-18T12:00:00Z')

async function seedPortal(grantRevokedAt: Date | null = null, status = 'active'): Promise<string> {
  const rows = await getDb()
    .insert(schema.portals)
    .values({
      memberId: randomUUID().replace(/-/g, ''),
      domain: 'portal.bitrix24.by',
      accessToken: 'шифротекст-доступа',
      refreshToken: 'шифротекст-обновления',
      applicationToken: 'шифротекст-приложения',
      tokenExpiresAt: new Date(NOW.getTime() + 3600_000),
      scopes: ['crm'],
      status,
      grantRevokedAt,
    })
    .returning({ id: schema.portals.id })
  return rows[0]!.id
}

async function readPortal(id: string) {
  const rows = await getDb()
    .select({
      status: schema.portals.status,
      accessToken: schema.portals.accessToken,
      refreshToken: schema.portals.refreshToken,
      applicationToken: schema.portals.applicationToken,
      scopes: schema.portals.scopes,
      grantRevokedAt: schema.portals.grantRevokedAt,
    })
    .from(schema.portals)
    .where(sql`${schema.portals.id} = ${id}`)
  return rows[0]!
}

describe.skipIf(!enabled)('жизнь портала после установки', () => {
  beforeEach(async () => {
    await getDb().execute(sql`truncate table ${schema.portals} cascade`)
  })

  it('отметка мёртвого гранта ставится первым отказом', async () => {
    const id = await seedPortal()
    await markGrantRevoked(id, NOW)

    expect((await readPortal(id)).grantRevokedAt?.toISOString()).toBe(NOW.toISOString())
  })

  it('повторный отказ НЕ отодвигает срок', async () => {
    // ⚠ Главный тест файла. Перепиши отметку — и портал не будет стёрт никогда,
    // потому что отказы идут каждую минуту, а срок отсчитывается от последнего.
    const id = await seedPortal()
    await markGrantRevoked(id, NOW)
    await markGrantRevoked(id, new Date(NOW.getTime() + 10 * DAY_MS))

    expect((await readPortal(id)).grantRevokedAt?.toISOString()).toBe(NOW.toISOString())
  })

  it('успешное продление снимает отметку', async () => {
    const id = await seedPortal(new Date(NOW.getTime() - 5 * DAY_MS))
    await saveRefreshedTokens(id, {
      accessToken: 'новый-доступ',
      refreshToken: 'новое-обновление',
      expiresAt: new Date(NOW.getTime() + 3600_000),
      previousRefreshToken: 'шифротекст-обновления',
    })

    const portal = await readPortal(id)
    expect(portal.grantRevokedAt).toBeNull()
    expect(portal.accessToken).toBe('новый-доступ')
  })

  it('второй обменщик не затирает пару первого', async () => {
    // ⚠ Гонка из issue #19, воспроизведённая целиком. Вкладка в карточке сделки делает два
    // запроса подряд, сотрудников на портале много — и два обработчика идут обменивать один
    // и тот же протухший токен. Обмен ВРАЩАЕТ грант, поэтому пара проигравшего мертва
    // в момент записи. Без compare-and-swap последний писатель клал в базу мёртвый токен,
    // и портал отвечал отказом на всё до переустановки приложения.
    const id = await seedPortal()
    const went = 'шифротекст-обновления'

    // Первый успел.
    await saveRefreshedTokens(id, {
      accessToken: 'доступ-первого',
      refreshToken: 'обновление-первого',
      expiresAt: new Date(NOW.getTime() + 3600_000),
      previousRefreshToken: went,
    })
    // Второй шёл с той же старой парой и опоздал.
    await saveRefreshedTokens(id, {
      accessToken: 'доступ-второго',
      refreshToken: 'мёртвое-обновление-второго',
      expiresAt: new Date(NOW.getTime() + 3600_000),
      previousRefreshToken: went,
    })

    const portal = await readPortal(id)
    expect(portal.refreshToken).toBe('обновление-первого')
    expect(portal.accessToken).toBe('доступ-первого')
  })

  it('продление НЕ воскрешает стёртый портал', async () => {
    // ⚠ Гонка, ради которой `saveRefreshedTokens` сделан условным: продление началось
    // до стирания и закончилось после. Без условия оно вернуло бы живые токены клиента,
    // который ушёл, — и никакой перечиткой это окно не закрыть, между ними сетевой вызов.
    const id = await seedPortal()
    await purgePortalTokens(id, 'grant-dead')

    await saveRefreshedTokens(id, {
      accessToken: 'воскрешённый-доступ',
      refreshToken: 'воскрешённое-обновление',
      expiresAt: new Date(NOW.getTime() + 3600_000),
      previousRefreshToken: 'шифротекст-обновления',
    })

    const portal = await readPortal(id)
    expect(portal.status).toBe('deleted')
    expect(portal.accessToken).toBeNull()
  })

  it('стирание убирает все секреты, но оставляет строку', async () => {
    // Строку удалять нельзя: на портал ссылаются недоставленные ответы живых людей.
    const id = await seedPortal()
    expect(await purgePortalTokens(id, 'grant-dead')).toBe(true)

    const portal = await readPortal(id)
    expect(portal.status).toBe('deleted')
    expect(portal.accessToken).toBeNull()
    expect(portal.refreshToken).toBeNull()
    expect(portal.applicationToken).toBeNull()
    expect(portal.scopes).toBeNull()
  })

  it('повторное стирание ничего не делает', async () => {
    const id = await seedPortal()
    await purgePortalTokens(id, 'grant-dead')

    expect(await purgePortalTokens(id, 'grant-dead')).toBe(false)
  })

  it('уборщик берёт только тех, у кого срок вышел', async () => {
    const old = await seedPortal(new Date(NOW.getTime() - 20 * DAY_MS))
    const fresh = await seedPortal(new Date(NOW.getTime() - 3 * DAY_MS))
    const alive = await seedPortal(null)

    expect(await purgeDeadPortals(NOW)).toBe(1)

    expect((await readPortal(old)).status).toBe('deleted')
    expect((await readPortal(fresh)).status).toBe('active')
    expect((await readPortal(alive)).status).toBe('active')
  })

  it('уборщик не берёт больше предела за раз', async () => {
    // ⚠ Предел обязателен: одна ошибка классификации иначе унесла бы всех клиентов разом,
    // а стереть можно только один раз.
    for (let i = 0; i < 4; i += 1) await seedPortal(new Date(NOW.getTime() - (30 + i) * DAY_MS))

    expect(await purgeDeadPortals(NOW, 2)).toBe(2)
    expect(await purgeDeadPortals(NOW, 2)).toBe(2)
    expect(await purgeDeadPortals(NOW, 2)).toBe(0)
  })

  it('счётчик для health считает только живых под отсчётом', async () => {
    await seedPortal(new Date(NOW.getTime() - 2 * DAY_MS))
    await seedPortal(null)
    const purged = await seedPortal(new Date(NOW.getTime() - 40 * DAY_MS))
    await purgePortalTokens(purged, 'grant-dead')

    expect(await countRevokedPortals()).toBe(1)
  })
})
