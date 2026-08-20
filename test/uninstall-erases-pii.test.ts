import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { TokenCipher } from '../src/bitrix24/crypto'
import { PortalTokenStore } from '../src/bitrix24/portal'
import { PgStore } from '../src/store/pg'
import { PgInvitationStore } from '../src/store/pg-invitation'
import { ensureDefaultPortal, LOCAL_PORTAL_MEMBER_ID } from '../src/store/bootstrap'
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
    context: { dealId: 759, companyId: 101, responsibleName: 'Иванов' },
    answers: [{ questionKey: 'q_nps', metric: 'nps', valueChoice: ['n9'], valueNumber: 9, valueText: null }],
    invitationToken: inv.token
  })
}

async function counts(): Promise<Record<string, number>> {
  const one = async (t: string): Promise<number> =>
    Number((await db.query<{ n: string }>(`select count(*)::int as n from ${t}`)).rows[0]!.n)
  return {
    portal: await one('portal'),
    response: await one('response'),
    response_answer: await one('response_answer'),
    invitation: await one('invitation'),
    survey: await one('survey')
  }
}

describe('удаление приложения стирает накопленные ПДн (#171)', () => {
  it('данные копились под плейсхолдером → установка → удаление стирает ВСЁ', async () => {
    const adopted: string[] = []
    const store = new PortalTokenStore(db, new TokenCipher(key), { onAdopt: (m) => adopted.push(m) })

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

    await store.deletePortal(MEMBER, Math.floor(NOW.getTime() / 1000))
    expect(await counts()).toEqual({ portal: 0, response: 0, response_answer: 0, invitation: 0, survey: 0 })
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
    const store = new PortalTokenStore(db, new TokenCipher(key))
    const portalId = await ensureDefaultPortal(db)
    await accumulate(portalId)
    await store.save(tokens(), { adoptLocal: true })
    // Повторная установка того же портала: присваивать нечего, данные на месте.
    expect(await store.save(tokens({ accessToken: 'at2' }), { adoptLocal: true })).toBe(true)
    expect((await counts()).portal).toBe(1)
    expect((await counts()).response).toBe(1)
    expect((await store.load(MEMBER))?.accessToken).toBe('at2')
  })
})
