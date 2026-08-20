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
 * Сквозной сценарий #171: **удаление приложения обязано стирать персональные данные.**
 *
 * ⚠️ Раньше не стирало, и это не читалось по коду. До связки с Bitrix весь трафик контура A пишется
 * под плейсхолдер-портал (`__local__`), и там же копятся ответы со снимками CRM. Установка заводила
 * ВТОРУЮ строку портала — с настоящим `member_id`, — и `deletePortal(memberId)` чистил именно её:
 * находил портал без единого ответа, рапортовал об успехе, а ПДн оставались в базе навсегда.
 * Требование Маркета формально выполнялось, фактически — нет.
 *
 * Поэтому тест исполняет ВЕСЬ путь, а не проверяет отдельные функции: копим данные до установки →
 * ставим приложение → удаляем → смотрим, что в базе не осталось ничего.
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

describe('удаление приложения стирает накопленные ПДн (#171)', () => {
  it('данные копились под плейсхолдером → установка → удаление стирает ВСЁ', async () => {
    const adopted: string[] = []
    const store = new PortalTokenStore(db, new TokenCipher(key), {
      onAdopt: (o) => { if (o.kind === 'adopted') adopted.push(o.memberId) }
    })

    const portalId = await ensureDefaultPortal(db)
    await accumulate(portalId)
    expect((await counts()).response, 'нечего проверять — данные не накопились').toBe(1)

    // Установка: плейсхолдер ПЕРЕИМЕНОВЫВАЕТСЯ, а не дублируется.
    expect(await store.save(tokens(), { adoptLocal: true })).toBe(true)
    expect(adopted, 'присвоение не произошло или прошло молча').toEqual([MEMBER])
    expect((await counts()).portal, 'установка завела ВТОРОЙ портал — данные разъехались').toBe(1)
    // Числовой id не изменился: уже открытый PgStore продолжает работать без перезапуска.
    const after = await db.query<{ id: number }>('select id from portal where member_id = $1', [MEMBER])
    expect(after.rows[0]!.id).toBe(portalId)

    const filled = await counts()
    expect(filled.response, 'нечего проверять').toBe(1)
    expect(filled.answer_insight, 'пересказ ответа не создан — проверка стирания смотрит в пустоту').toBe(1)
    await store.deletePortal(MEMBER, Math.floor(NOW.getTime() / 1000))
    const wiped = await counts()
    expect(allZero(wiped), `в базе осталось: ${JSON.stringify(wiped)}`).toBe(true)
  })

  it('БЕЗ присвоения удаление рапортует об успехе, а ПДн остаются (регрессия, ради которой всё)', async () => {
    // Явно воспроизводим прежнее поведение: тот же путь, но `adoptLocal` не передан.
    const store = new PortalTokenStore(db, new TokenCipher(key))
    await accumulate(await ensureDefaultPortal(db))
    await store.save(tokens()) // без adoptLocal — заводит вторую строку
    expect((await counts()).portal).toBe(2)
    await store.deletePortal(MEMBER, Math.floor(NOW.getTime() / 1000))
    // Портал «удалён», а ответ со снимком CRM жив — ровно то, что чинит #171.
    expect(await store.load(MEMBER)).toBeUndefined()
    expect((await counts()).response, 'ожидалось прежнее (дефектное) поведение').toBe(1)
  })

  it('рестарт после установки НЕ заводит второй плейсхолдер', async () => {
    // Иначе данные разъехались бы снова — и теперь уже после каждого рестарта.
    const store = new PortalTokenStore(db, new TokenCipher(key))
    const portalId = await ensureDefaultPortal(db)
    await accumulate(portalId)
    await store.save(tokens(), { adoptLocal: true })
    const onRestart = await ensureDefaultPortal(db)
    expect(onRestart, 'старт увёл запись в новый пустой портал').toBe(portalId)
    expect((await counts()).portal).toBe(1)
    const row = await db.query<{ member_id: string }>('select member_id from portal where id = $1', [portalId])
    expect(row.rows[0]!.member_id).toBe(MEMBER)
  })

  it('после clean-uninstall процесс не остаётся с мёртвым portalId (кэш сброшен)', async () => {
    // ⚠️ Регрессия, которую породило само присвоение. Раньше плейсхолдер uninstall переживал —
    // удалялась вторая, пустая строка, — и инстанс работал дальше. Теперь `deletePortal` сносит РОВНО
    // ту строку, на id которой прибит открытый `PgStore`: без пересборки каждая запись падала бы на
    // FK, а переустановка без рестарта не лечила бы (у новой строки НОВЫЙ id). Проверяем не сам
    // кэш (он в Nitro-слое), а инвариант, на котором он держится: после удаления и переустановки
    // `ensureDefaultPortal` отдаёт id ЖИВОЙ строки, и запись по нему проходит.
    const store = new PortalTokenStore(db, new TokenCipher(key))
    const before = await ensureDefaultPortal(db)
    await accumulate(before)
    await store.save(tokens(), { adoptLocal: true })
    await store.deletePortal(MEMBER, Math.floor(NOW.getTime() / 1000))
    expect((await counts()).portal).toBe(0)

    // Переустановка (тумбстоун снимается более новым событием) + пересборка привязки.
    await store.save(tokens(), { eventTs: Math.floor(NOW.getTime() / 1000) + 60, adoptLocal: true })
    const after = await ensureDefaultPortal(db)
    expect(after, 'привязка осталась на удалённой строке').not.toBe(before)
    await expect(accumulate(after), 'запись после переустановки бьётся об FK').resolves.toBeUndefined()
  })

  it('НАСТОЯЩИЙ портал приоритетнее плейсхолдера при выборе на старте', async () => {
    // Обычное удаление приложения идёт с CLEAN=0 — строка портала ОСТАЁТСЯ. Тестовый портал
    // поставили и удалили без очистки → рядом плейсхолдер → ставят боевой. По правилу «самый ранний»
    // инстанс писал бы под плейсхолдер (он старше), удаление боевого чистило бы пустую строку, и
    // #171 вернулся бы — теперь уже неизлечимо ни рестартом, ни переустановкой.
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

  it('присвоение НЕ состоялось → это видно наружу (ПДн остались за плейсхолдером)', async () => {
    // Молчание здесь было бы худшим вариантом: работающим выглядел бы именно провал.
    const seen: string[] = []
    const store = new PortalTokenStore(db, new TokenCipher(key), { onAdopt: (o) => seen.push(o.kind) })
    await ensureDefaultPortal(db)
    await db.query(`insert into portal (member_id, domain, tokens) values ('чужой', 'x.b24', '{}'::jsonb)`)
    await store.save(tokens(), { adoptLocal: true })
    expect(seen).toEqual(['skipped'])
  })

  it('чужая установка НЕ присваивает накопленное, когда задан ожидаемый портал', async () => {
    // В Маркете install-URL один на всех: приложение может поставить кто угодно, включая модератора
    // или партнёра с тестового портала. Без гейта он присвоил бы чужие ПДн — и смог бы их стереть.
    const seen: string[] = []
    const store = new PortalTokenStore(db, new TokenCipher(key), { onAdopt: (o) => seen.push(o.kind) })
    const localId = await ensureDefaultPortal(db)
    await accumulate(localId)
    await store.save(tokens({ memberId: 'чужой-портал' }), { adoptLocal: true, expectedMemberId: MEMBER })
    expect(seen).toEqual(['refused'])
    const local = await db.query('select 1 from portal where member_id = $1', [LOCAL_PORTAL_MEMBER_ID])
    expect(local.rows.length, 'чужая установка присвоила накопленное').toBe(1)
  })

  it('присваивается ИМЕННО плейсхолдер, а не «единственная строка портала»', async () => {
    // ⚠️ Мутация «присваивать любой единственный портал» иначе проходит молча: установка портала B
    // переименовала бы строку установленного портала A, данные A стали бы данными B, а последующее
    // удаление приложения на A не нашло бы ничего.
    const store = new PortalTokenStore(db, new TokenCipher(key))
    await db.query(`insert into portal (member_id, domain, tokens) values ('AAA', 'a.b24', '{}'::jsonb)`)
    const aId = (await db.query<{ id: number }>('select id from portal where member_id = $1', ['AAA'])).rows[0]!.id
    await accumulate(aId)
    const seen: string[] = []
    const hooked = new PortalTokenStore(db, new TokenCipher(key), { onAdopt: (o) => seen.push(o.kind) })
    await hooked.save(tokens({ memberId: 'BBB' }), { adoptLocal: true })
    // Строка AAA цела, её данные на месте, BBB — отдельная строка.
    const rows = await db.query<{ member_id: string }>('select member_id from portal order by id')
    expect(rows.rows.map((r) => r.member_id)).toEqual(['AAA', 'BBB'])
    const owned = await db.query('select 1 from survey_group where portal_id = $1', [aId])
    expect(owned.rows.length, 'данные портала AAA уехали к BBB').toBe(1)
    // Плейсхолдера нет вовсе → это не «пропущенное присвоение», сообщать не о чем.
    expect(seen).toEqual([])
    expect(store).toBeDefined()
  })

  it('ТУМБСТОУН старше события → ни токенов, ни присвоения', async () => {
    // ⚠️ Прод зовёт `save({ eventTs, adoptLocal: true })` — обе опции вместе, и порядок между ними
    // важен. Встань блок присвоения ВЫШЕ тумбстоун-гарда, опоздавший install переименовал бы
    // плейсхолдер в member_id уже удалённого портала: `save` вернул бы `false`, а плейсхолдера в базе
    // больше нет — следующая настоящая установка присваивать было бы нечего, и #171 вернулся бы.
    const seen: string[] = []
    const store = new PortalTokenStore(db, new TokenCipher(key), { onAdopt: (o) => seen.push(o.kind) })
    await ensureDefaultPortal(db)
    await db.query(
      'insert into portal_tombstone (member_id, deleted_ts) values ($1, $2)',
      [MEMBER, 2000]
    )
    expect(await store.save(tokens(), { eventTs: 1000, adoptLocal: true })).toBe(false)
    const rows = await db.query<{ member_id: string }>('select member_id from portal')
    expect(rows.rows.map((r) => r.member_id), 'опоздавший install присвоил плейсхолдер')
      .toEqual([LOCAL_PORTAL_MEMBER_ID])
    expect(seen).toEqual([])
  })

  it('присвоение НЕ трогает чужие данные, если портал в базе уже не один', async () => {
    // При нескольких порталах непонятно, чьи данные лежат под плейсхолдером; присвоение отдало бы
    // накопленное портала A порталу B. Условие живёт в SQL, а не в вызывающем коде.
    const store = new PortalTokenStore(db, new TokenCipher(key))
    await ensureDefaultPortal(db)
    await db.query(`insert into portal (member_id, domain, tokens) values ('чужой', 'x.b24', '{}'::jsonb)`)
    await store.save(tokens(), { adoptLocal: true })
    const local = await db.query('select 1 from portal where member_id = $1', [LOCAL_PORTAL_MEMBER_ID])
    expect(local.rows.length, 'плейсхолдер присвоен при нескольких порталах').toBe(1)
    expect((await counts()).portal).toBe(3)
  })

  it('присвоение НЕ трогает уже установленный портал (переустановка)', async () => {
    const seen: string[] = []
    const store = new PortalTokenStore(db, new TokenCipher(key), { onAdopt: (o) => seen.push(o.kind) })
    const portalId = await ensureDefaultPortal(db)
    await accumulate(portalId)
    await store.save(tokens(), { adoptLocal: true })
    // Повторная установка того же портала: присваивать нечего, данные на месте.
    expect(await store.save(tokens({ accessToken: 'at2' }), { adoptLocal: true })).toBe(true)
    expect((await counts()).portal).toBe(1)
    expect((await counts()).response).toBe(1)
    expect((await store.load(MEMBER))?.accessToken).toBe('at2')
    // ⚠️ Ровно ОДНО присвоение. Строка `portal_adopted_local` — единственная видимость разового
    // события; печатайся она на каждой переустановке, по ней нельзя было бы судить, состоялось ли оно.
    expect(seen).toEqual(['adopted'])
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
