import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'
import { registerPortal } from '../../server/b24/register'
import { saveRefreshedTokens } from '../../server/links/issue'
import { PURGE_GRACE_DAYS } from '../../server/domain/portals/lifecycle'
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

// ⚠ `registerPortal` шифрует токены, значит ключ обязан быть. Значение тестовое
// и заведомо не боевое: важно только, что оно разворачивается в 32 байта.
process.env.B24_TOKEN_ENC_KEY ||= Buffer.alloc(32, 7).toString('base64')

const enabled = isDatabaseConfigured()
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-18T12:00:00Z')
/** Сроки считаем ОТ константы отсрочки: её значение проверяет юнит-тест отдельно,
 *  а здесь важно только «раньше границы» и «позже границы». */
const OVERDUE = PURGE_GRACE_DAYS + 5
const RECENT = PURGE_GRACE_DAYS - 5

async function seedPortal(grantRevokedAt: Date | null = null, status = 'active', memberId?: string): Promise<string> {
  const rows = await getDb()
    .insert(schema.portals)
    .values({
      memberId: memberId ?? randomUUID().replace(/-/g, ''),
      domain: DOMAIN,
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

/**
 * ⚠ Стираем ТОЛЬКО свои строки, а не таблицу.
 *
 * Здесь стоял `truncate table portals cascade`, и это унесло бы у разработчика, запустившего
 * `pnpm check` с `DATABASE_URL` на своей базе, все установленные порталы, а каскадом — все
 * недоставленные ответы и выпущенные ссылки. Нашла панель ревью PR #34.
 *
 * ⚠ Первая редакция этого абзаца добавляла, что соседний `inbox-claim.test.ts` «уже избегает
 * этого и чистит по своему домену». Это было НЕПРАВДОЙ: он чистил `truncate table inbox
 * cascade`, то есть ту же беду в соседней таблице. Ссылаться на соседа как на образец,
 * не открыв его, — как раз тот способ, которым дефект расходится по файлам вместо того,
 * чтобы чиниться. Исправлено там же.
 */
const DOMAIN = 'db-test-lifecycle.bitrix24.by'

async function wipe() {
  await getDb().delete(schema.portals).where(eq(schema.portals.domain, DOMAIN))
}

describe.skipIf(!enabled)('жизнь портала после установки', () => {
  beforeEach(wipe)
  afterAll(wipe)

  it('отметка мёртвого гранта ставится первым отказом', async () => {
    const id = await seedPortal()
    await markGrantRevoked(id, NOW, 'шифротекст-обновления')

    expect((await readPortal(id)).grantRevokedAt?.toISOString()).toBe(NOW.toISOString())
  })

  it('повторный отказ НЕ отодвигает срок', async () => {
    // ⚠ Главный тест файла. Перепиши отметку — и портал не будет стёрт никогда,
    // потому что отказы идут каждую минуту, а срок отсчитывается от последнего.
    const id = await seedPortal()
    await markGrantRevoked(id, NOW, 'шифротекст-обновления')
    await markGrantRevoked(id, new Date(NOW.getTime() + 10 * DAY_MS), 'шифротекст-обновления')

    expect((await readPortal(id)).grantRevokedAt?.toISOString()).toBe(NOW.toISOString())
  })

  it('НЕ помечает проигравшего гонку продления', async () => {
    // ⚠ Два обработчика пошли обменивать один токен; победитель провернул грант, и обмен
    // проигравшего честно отвечает `invalid_grant`. Портал при этом ЖИВ. Без условия по паре
    // штатная гонка запускала бы отсчёт до стирания токенов работающего клиента.
    // Нашла повторная панель ревью PR #34.
    const id = await seedPortal()

    await markGrantRevoked(id, NOW, 'пара-с-которой-шли-но-её-уже-провернули')

    expect((await readPortal(id)).grantRevokedAt).toBeNull()
  })

  it('успешное продление снимает отметку', async () => {
    const id = await seedPortal(new Date(NOW.getTime() - RECENT * DAY_MS))
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
    //
    // ⚠ Портал заводится `deleted` НАПРЯМУЮ, а не проходом через `purgePortalTokens`.
    // Прежняя редакция шла через стирание, а оно тем же запросом обнуляет `refresh_token` —
    // и запись не проходила из-за compare-and-swap, а не из-за условия по статусу. Мутация
    // `ne(status, 'deleted')` не роняла ни одного теста: гвард зеленел по чужой причине
    // и не доказывал то, что называл. Нашла панель ревью PR #34.
    const id = await seedPortal(null, 'deleted')

    await saveRefreshedTokens(id, {
      accessToken: 'воскрешённый-доступ',
      refreshToken: 'воскрешённое-обновление',
      expiresAt: new Date(NOW.getTime() + 3600_000),
      // Пара та самая, что лежит в строке: CAS совпал бы, и удержать запись обязано
      // именно условие по статусу.
      previousRefreshToken: 'шифротекст-обновления',
    })

    const portal = await readPortal(id)
    expect(portal.status).toBe('deleted')
    expect(portal.accessToken).toBe('шифротекст-доступа')
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
    const old = await seedPortal(new Date(NOW.getTime() - OVERDUE * DAY_MS))
    const fresh = await seedPortal(new Date(NOW.getTime() - RECENT * DAY_MS))
    const alive = await seedPortal(null)

    expect(await purgeDeadPortals(NOW)).toBe(1)

    expect((await readPortal(old)).status).toBe('deleted')
    expect((await readPortal(fresh)).status).toBe('active')
    expect((await readPortal(alive)).status).toBe('active')
  })

  it('уборщик не берёт больше предела за раз', async () => {
    // ⚠ Предел обязателен: одна ошибка классификации иначе унесла бы всех клиентов разом,
    // а стереть можно только один раз.
    for (let i = 0; i < 4; i += 1) await seedPortal(new Date(NOW.getTime() - (OVERDUE + i) * DAY_MS))

    expect(await purgeDeadPortals(NOW, 2)).toBe(2)
    expect(await purgeDeadPortals(NOW, 2)).toBe(2)
    expect(await purgeDeadPortals(NOW, 2)).toBe(0)
  })

  it('переустановка снимает отметку мёртвого гранта', async () => {
    // ⚠ Гвард под дефект, который ломал механизм об себя. `ON CONFLICT DO UPDATE` не трогает
    // колонки, которых нет в списке, — и портал, вернувшийся после стирания, приходил
    // со свежими токенами и старой просроченной отметкой. Первый же тик уборщика стирал их
    // снова, в течение минуты. Клиент переустанавливает приложение, оно «не запоминается»,
    // и понять это без похода в базу нельзя. Нашла панель ревью PR #34.
    const memberId = randomUUID().replace(/-/g, '')
    await seedPortal(new Date(NOW.getTime() - OVERDUE * DAY_MS), 'deleted', memberId)

    await registerPortal({
      memberId,
      domain: DOMAIN,
      accessToken: 'свежий-доступ',
      refreshToken: 'свежее-обновление',
      applicationToken: '',
      expiresInSeconds: 3600,
      scope: ['crm'],
    })

    const rows = await getDb()
      .select({ id: schema.portals.id, grantRevokedAt: schema.portals.grantRevokedAt, status: schema.portals.status })
      .from(schema.portals)
      .where(eq(schema.portals.memberId, memberId))

    expect(rows[0]!.grantRevokedAt).toBeNull()
    // Уборщик после переустановки этот портал не трогает — это и есть смысл гварда.
    expect(await purgeDeadPortals(NOW)).toBe(0)
  })

  it('не стирает, когда под отсчётом больше трети флота', async () => {
    // ⚠ Предохранитель по доле флота. Треть помеченных — это не исход клиентов, а наша
    // поломка: разъехался ключ шифрования, сломалась классификация, лёг сервер авторизации.
    // Стирать в такой момент нельзя, а отказ стирания — единственный способ узнать
    // о поломке, пока она ещё обратима. Приём у соседа (`fleetBreach`).
    // Флот должен быть достаточно большим, чтобы доля вообще была долей: ниже нижней
    // границы предохранитель молчит намеренно, иначе он выключил бы стирание на одном
    // портале навсегда.
    for (let i = 0; i < 4; i += 1) await seedPortal(new Date(NOW.getTime() - (OVERDUE + i) * DAY_MS))
    for (let i = 0; i < 7; i += 1) await seedPortal(null)

    expect(await purgeDeadPortals(NOW)).toBe(0)
  })

  it('счётчик для health считает только живых под отсчётом', async () => {
    await seedPortal(new Date(NOW.getTime() - RECENT * DAY_MS))
    await seedPortal(null)
    const purged = await seedPortal(new Date(NOW.getTime() - OVERDUE * DAY_MS))
    await purgePortalTokens(purged, 'grant-dead')

    expect(await countRevokedPortals()).toBe(1)
  })
})
