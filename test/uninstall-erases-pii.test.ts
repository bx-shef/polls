import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { TokenCipher } from '../src/bitrix24/crypto'
import { PortalTokenStore } from '../src/bitrix24/portal'
import { PgStore } from '../src/store/pg'
import { PgInvitationStore } from '../src/store/pg-invitation'
import { ensureDefaultPortal, LOCAL_PORTAL_MEMBER_ID } from '../src/store/bootstrap'
import { memberIdByPortalId } from '../src/bitrix24/portal'
import type { Queryable } from '../src/store/types'
import type { OAuthTokens } from '../src/bitrix24/oauth'
import { draftV2, SURVEY_KEY } from '../src/demo/seed'
import { applySchema } from './helpers/schema'

/**
 * Сквозной сценарий #171: **удаление приложения обязано стирать данные ПОРТАЛА.**
 *
 * ⚠️ История вопроса, потому что решение здесь менялось ДВАЖДЫ. Исходный дефект: до мультитенанта
 * весь трафик писался под плейсхолдер (`__local__`), установка заводила вторую строку, и
 * `deletePortal` чистил её — пустую: рапорт об успехе, ПДн навсегда в базе. Первое лечение —
 * ПРИСВОЕНИЕ плейсхолдера установившемуся порталу — само оказалось дырой (#183): в Маркете
 * install-URL один на всех, и «накопленное присваивает первый установившийся» отдавало данные кому
 * угодно. Присвоение снято (решение владельца, 2026-08-22, по образцу `ai-price-import`).
 *
 * Действующая модель: каждый портал — свой тенант с момента установки (#47/#49), все его данные
 * пишутся ТОЛЬКО под его `portal_id`, и `deletePortal` стирает ровно их. Данные, накопленные ДО
 * установки под плейсхолдером, — автономное использование сервиса владельцем (демо, публичные
 * ссылки), они НЕ принадлежат ни одному порталу и uninstall'ом не стираются — их чистит владелец.
 */
const key = randomBytes(32)
let pg: PGlite
let db: Queryable

beforeAll(async () => {
  pg = new PGlite()
  await applySchema(pg)
  db = pg as unknown as Queryable
})
afterAll(async () => { await pg.close() })
beforeEach(async () => {
  await db.query('truncate table portal restart identity cascade')
  await db.query('delete from portal_tombstone')
})

const NOW = new Date('2026-08-20T10:00:00.000Z')
const MEMBER = 'member-real-0000000000000000'
const tokens = (over: Partial<OAuthTokens> = {}): OAuthTokens => ({
  memberId: MEMBER,
  domain: 'acme.bitrix24.ru',
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: '2026-08-20T11:00:00.000Z',
  clientEndpoint: 'https://acme.bitrix24.ru/rest/',
  ...over
})

/** Данные, которые накопились ДО установки: опубликованный опрос, приглашение и ответ со снимком CRM. */
async function accumulate(portalId: number): Promise<void> {
  const store = new PgStore(db, { portalId })
  await store.publish(draftV2(), 2)
  const invitations = new PgInvitationStore(db, { portalId })
  const inv = await invitations.create(
    { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 759, responsibleName: 'Иванов' } },
    NOW
  )
  await store.addResponse({
    id: 'r-1',
    surveyKey: SURVEY_KEY,
    versionNo: 2,
    submittedAt: NOW.toISOString(),
    // Снимок CRM с ПДн + товарная позиция: производные ПДн должны попасть под удаление тоже.
    context: {
      dealId: 759, companyId: 101, responsibleName: 'Иванов',
      products: [{ productId: 1001, productName: 'Внедрение' }]
    },
    answers: [
      { questionKey: 'q_nps', metric: 'nps', valueChoice: ['n9'], valueNumber: 9, valueText: null },
      { questionKey: 'q_comment', metric: 'text', valueChoice: [], valueNumber: null, valueText: 'менеджер Иванов молодец' }
    ],
    invitationToken: inv.token
  })
  // Пересказ свободного текста (`answer_insight.summary`) и пользователь портала — самые
  // чувствительные производные; без них проверка стирания смотрела бы на пустое место.
  const resp = await db.query<{ id: string }>('select id from response where portal_id = $1', [portalId])
  await db.query(
    `insert into answer_insight (response_id, question_key, summary) values ($1, $2, $3)`,
    [resp.rows[0]!.id, 'q_comment', 'клиент доволен работой Иванова']
  )
  await db.query('insert into app_user (portal_id, b24_user_id) values ($1, 7)', [portalId])
}

/**
 * Сколько строк в КАЖДОЙ таблице схемы.
 *
 * ⚠️ Перечень берётся из `information_schema`, а не хардкодом. Список из пяти таблиц пропустил бы
 * ровно то, ради чего тест написан: забытую в `deletePortal` таблицу с производными ПДн
 * (`answer_insight.summary` — пересказ свободного текста клиента, `response_product.product_name`).
 * Исключены `portal_tombstone` (остаётся намеренно, несёт только member_id + метку времени) и
 * служебная `pgmigrations`.
 */
const KEEP = new Set(['portal_tombstone', 'pgmigrations'])
async function counts(): Promise<Record<string, number>> {
  const t = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`
  )
  const out: Record<string, number> = {}
  for (const { table_name } of t.rows) {
    if (KEEP.has(table_name)) continue
    out[table_name] = Number(
      (await db.query<{ n: string }>(`select count(*)::int as n from ${table_name}`)).rows[0]!.n
    )
  }
  return out
}
const allZero = (c: Record<string, number>): boolean => Object.values(c).every((n) => n === 0)

describe('удаление приложения стирает данные ПОРТАЛА (#171)', () => {
  it('данные портала копятся под ЕГО тенантом → удаление стирает всё', async () => {
    const store = new PortalTokenStore(db, new TokenCipher(key))
    expect(await store.save(tokens())).toBe(true)
    const portalId = (await db.query<{ id: number }>(
      'select id from portal where member_id = $1', [MEMBER]
    )).rows[0]!.id
    await accumulate(portalId)
    const filled = await counts()
    expect(filled.response, 'нечего проверять — данные не накопились').toBe(1)
    expect(filled.answer_insight, 'пересказ ответа не создан — проверка стирания смотрит в пустоту').toBe(1)

    await store.deletePortal(MEMBER, Math.floor(NOW.getTime() / 1000))
    const wiped = await counts()
    expect(allZero(wiped), `в базе осталось: ${JSON.stringify(wiped)}`).toBe(true)
  })

  it('плейсхолдер установке НЕ присваивается — и данные автономного использования остаются его', async () => {
    // ⚠️ Это ОТМЕНА прежнего решения, а не пропуск (разбор — в шапке файла). Присвоение накопленного
    // первому установившемуся и было дырой #183: в Маркете установиться может кто угодно.
    const store = new PortalTokenStore(db, new TokenCipher(key))
    const localId = await ensureDefaultPortal(db)
    await accumulate(localId)

    expect(await store.save(tokens())).toBe(true)
    const rows = await db.query<{ member_id: string }>('select member_id from portal order by id')
    expect(rows.rows.map((r) => r.member_id), 'установка тронула строку плейсхолдера')
      .toEqual([LOCAL_PORTAL_MEMBER_ID, MEMBER])

    // Удаление ПОРТАЛА данные плейсхолдера не трогает: они не его.
    await store.deletePortal(MEMBER, Math.floor(NOW.getTime() / 1000))
    expect((await counts()).response, 'uninstall чужого портала стёр автономные данные владельца').toBe(1)
    const local = await db.query('select 1 from portal where member_id = $1', [LOCAL_PORTAL_MEMBER_ID])
    expect(local.rows.length).toBe(1)
  })

  it('переустановка обновляет токены, данных не трогает, вторых строк не плодит', async () => {
    const store = new PortalTokenStore(db, new TokenCipher(key))
    await store.save(tokens())
    const portalId = (await db.query<{ id: number }>(
      'select id from portal where member_id = $1', [MEMBER]
    )).rows[0]!.id
    await accumulate(portalId)
    expect(await store.save(tokens({ accessToken: 'at2' }))).toBe(true)
    expect((await counts()).portal).toBe(1)
    expect((await counts()).response).toBe(1)
    expect((await store.load(MEMBER))?.accessToken).toBe('at2')
  })

  it('после clean-uninstall процесс не остаётся с мёртвым portalId (привязка пересобирается)', async () => {
    const store = new PortalTokenStore(db, new TokenCipher(key))
    await store.save(tokens())
    const before = await ensureDefaultPortal(db)
    await accumulate(before)
    await store.deletePortal(MEMBER, Math.floor(NOW.getTime() / 1000))
    expect((await counts()).portal).toBe(0)

    // Переустановка (тумбстоун снимается более новым событием) + пересборка привязки.
    await store.save(tokens(), { eventTs: Math.floor(NOW.getTime() / 1000) + 60 })
    const after = await ensureDefaultPortal(db)
    expect(after, 'привязка осталась на удалённой строке').not.toBe(before)
    await expect(accumulate(after), 'запись после переустановки бьётся об FK').resolves.toBeUndefined()
  })

  it('НАСТОЯЩИЙ портал приоритетнее плейсхолдера при выборе на старте', async () => {
    // Правило выбора портала по умолчанию (фолбэк для путей без резолва): установленный портал
    // старше плейсхолдера по смыслу, даже если плейсхолдер старше по времени.
    const localId = await ensureDefaultPortal(db) // плейсхолдер создан ПЕРВЫМ
    await db.query(`insert into portal (member_id, domain, tokens) values ($1, 'acme.b24', '{}'::jsonb)`, [MEMBER])
    const chosen = await ensureDefaultPortal(db)
    expect(chosen, 'выбран плейсхолдер вместо установленного портала').not.toBe(localId)
    const row = await db.query<{ member_id: string }>('select member_id from portal where id = $1', [chosen])
    expect(row.rows[0]!.member_id).toBe(MEMBER)
  })

  it('несколько НАСТОЯЩИХ порталов → сообщаем списком, а не молча выбираем', async () => {
    await db.query(`insert into portal (member_id, domain, tokens) values ('m-a', 'a.b24', '{}'::jsonb)`)
    await db.query(`insert into portal (member_id, domain, tokens) values ('m-b', 'b.b24', '{}'::jsonb)`)
    const seen: Array<{ chosen: string; all: readonly string[] }> = []
    await ensureDefaultPortal(db, { onAmbiguous: (chosen, all) => seen.push({ chosen, all }) })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.chosen).toBe('m-a')
    expect(seen[0]!.all, 'без списка непонятно, кого с кем спутали').toEqual(['m-a', 'm-b'])
  })

  it('установка ЛЮБОГО портала не трогает ни плейсхолдер, ни чужие строки', async () => {
    // ⚠️ Главная гарантия после снятия присвоения: upsert идёт строго по СВОЕМУ member_id.
    // Мутация «переименовать какую-нибудь строку» (ровно то, что делало присвоение) видна сразу.
    await ensureDefaultPortal(db)
    await db.query(`insert into portal (member_id, domain, tokens) values ('AAA', 'a.b24', '{}'::jsonb)`)
    const store = new PortalTokenStore(db, new TokenCipher(key))
    await store.save(tokens({ memberId: 'BBB' }))
    const rows = await db.query<{ member_id: string }>('select member_id from portal order by id')
    expect(rows.rows.map((r) => r.member_id)).toEqual([LOCAL_PORTAL_MEMBER_ID, 'AAA', 'BBB'])
  })

  it('ТУМБСТОУН старше события → токены не сохраняются, строка не заводится', async () => {
    const store = new PortalTokenStore(db, new TokenCipher(key))
    await ensureDefaultPortal(db)
    await db.query(
      'insert into portal_tombstone (member_id, deleted_ts) values ($1, $2)',
      [MEMBER, 2000]
    )
    expect(await store.save(tokens(), { eventTs: 1000 })).toBe(false)
    const rows = await db.query<{ member_id: string }>('select member_id from portal')
    expect(rows.rows.map((r) => r.member_id)).toEqual([LOCAL_PORTAL_MEMBER_ID])
  })
})

describe('portal.id → member_id для закрытия дела (#177)', () => {
  /**
   * ⚠️ Спрашиваем ПО ТОМУ ЖЕ id, под которым пишет стор, а не «первый установленный». Второе правило
   * выбора тенанта разъезжается с первым молча: ответы легли бы в один портал, а закрытие дел пошло
   * бы в другой — с чужими токенами и чужими сделками.
   */
  it('отдаёт member_id ИМЕННО этого портала', async () => {
    await db.query(`insert into portal (member_id, domain, tokens) values ('m-a', 'a.b24', '{}'::jsonb)`)
    const b = await db.query<{ id: number }>(
      `insert into portal (member_id, domain, tokens) values ('m-b', 'b.b24', '{}'::jsonb) returning id`
    )
    expect(await memberIdByPortalId(db, b.rows[0]!.id)).toBe('m-b')
  })

  it('ПЛЕЙСХОЛДЕР не годится: токенов у него нет, ходить в CRM нечем', async () => {
    // Иначе фича умирала бы бесшумно: `tokenStore.load` пуст → тихий выход, и в логе НЕ будет ни
    // «закрыли», ни «не смогли».
    const id = await ensureDefaultPortal(db)
    expect(await memberIdByPortalId(db, id)).toBeUndefined()
  })

  it('строки нет (портал удалён под нами) → undefined, без падения', async () => {
    expect(await memberIdByPortalId(db, 99_999)).toBeUndefined()
  })
})
