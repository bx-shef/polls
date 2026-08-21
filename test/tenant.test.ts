import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { portalByInvitationToken, portalBySurveyKey } from '../src/store/tenant'
import { portalIdByMemberId } from '../src/bitrix24/portal'
import { LOCAL_PORTAL_MEMBER_ID } from '../src/store/types'
import { PgStore } from '../src/store/pg'
import { PgInvitationStore, hashToken } from '../src/store/pg-invitation'
import type { Queryable } from '../src/store/types'
import { draftV2, SURVEY_KEY } from '../src/demo/seed'
import { applySchema } from './helpers/schema'

/**
 * Резолв тенанта для ПУБЛИЧНЫХ запросов (#49).
 *
 * ⚠️ Цена ошибки конкретная и незаметная: выбрав не тот портал, сервис покажет клиенту одного
 * заказчика анкету другого и запишет ответ не туда. Ни клиент, ни менеджер этого не увидят —
 * анкета выглядит нормально, ответ «принят».
 */
let pg: PGlite
let db: Queryable

beforeAll(async () => {
  pg = new PGlite()
  await applySchema(pg)
  db = pg as unknown as Queryable
})
afterAll(async () => { await pg.close() })
beforeEach(async () => { await db.query('truncate table portal restart identity cascade') })

async function portal(member: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into portal (member_id, domain, tokens) values ($1, $2, '{}'::jsonb) returning id`,
    [member, `${member}.b24`]
  )
  return r.rows[0]!.id
}

describe('портал по токену приглашения — авторитетный путь', () => {
  it('токен указывает на СВОЙ портал, даже когда ключ опроса общий', async () => {
    const [a, b] = [await portal('m-a'), await portal('m-b')]
    for (const id of [a, b]) await new PgStore(db, { portalId: id }).publish(draftV2(), 2)
    const invB = await new PgInvitationStore(db, { portalId: b }).create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 1 } }, new Date()
    )
    expect(await portalByInvitationToken(db, hashToken(invB.token))).toBe(b)
  })

  it('неизвестный токен → undefined (а не «первый попавшийся»)', async () => {
    await portal('m-a')
    expect(await portalByInvitationToken(db, hashToken('нет-такого'))).toBeUndefined()
  })
})

describe('портал по ключу опроса — путь БЕЗ токена', () => {
  it('ключ опубликован одним порталом → он и есть тенант', async () => {
    const a = await portal('m-a')
    await portal('m-b') // второй портал есть, но этого опроса не публиковал
    await new PgStore(db, { portalId: a }).publish(draftV2(), 2)
    expect(await portalBySurveyKey(db, SURVEY_KEY)).toEqual({ kind: 'portal', portalId: a })
  })

  it('ОДИН ключ у ДВУХ порталов → отказываемся выбирать', async () => {
    // ⚠️ Ровно тот случай, ради которого резолвер и написан: `csat_postdeal` заводит себе каждый
    // портал. «Взять первый» показало бы клиенту чужую анкету, и заметить это невозможно.
    const [a, b] = [await portal('m-a'), await portal('m-b')]
    for (const id of [a, b]) await new PgStore(db, { portalId: id }).publish(draftV2(), 2)
    expect(await portalBySurveyKey(db, SURVEY_KEY)).toEqual({ kind: 'ambiguous', count: 2 })
  })

  it('такого опроса нет ни у кого → unknown', async () => {
    await portal('m-a')
    expect(await portalBySurveyKey(db, 'нет-такого')).toEqual({ kind: 'unknown' })
  })

  it('портал с ЧЕРНОВИКОМ неоднозначности не создаёт', async () => {
    // Черновик наружу не отдаётся, и портал, который только завёл опрос, не должен делать чужой
    // опубликованный ключ невыдаваемым — иначе один заказчик ломает публичные ссылки другому.
    const [a, b] = [await portal('m-a'), await portal('m-b')]
    await new PgStore(db, { portalId: a }).publish(draftV2(), 2)
    // Опрос без версий у портала B — ровно то, что даёт `publish` до первой публикации.
    const g = await db.query<{ id: number }>(
      `insert into survey_group (portal_id, title) values ($1, 'default') returning id`, [b]
    )
    await db.query(
      `insert into survey (group_id, survey_key, title, lang) values ($1, $2, 'Черновик', 'ru')`,
      [g.rows[0]!.id, SURVEY_KEY]
    )
    expect(await portalBySurveyKey(db, SURVEY_KEY)).toEqual({ kind: 'portal', portalId: a })
  })
})

describe('портал по member_id — путь ИЗ ФРЕЙМА (#47)', () => {
  it('member_id подписанной сессии → числовой id СВОЕГО портала', async () => {
    const [a, b] = [await portal('m-a'), await portal('m-b')]
    expect(await portalIdByMemberId(db, 'm-a')).toBe(a)
    expect(await portalIdByMemberId(db, 'm-b')).toBe(b)
  })

  it('портала с таким member_id нет → undefined (приложение удалили при живой сессии)', async () => {
    await portal('m-a')
    expect(await portalIdByMemberId(db, 'm-удалён')).toBeUndefined()
  })

  it('плейсхолдер-портал арендатором НЕ считается', async () => {
    // Строка-заглушка для работы без связки с Bitrix24. Отдай её как тенанта — и запрос из фрейма
    // читал бы данные, которые копились до установки, от имени портала, который их не создавал.
    await portal(LOCAL_PORTAL_MEMBER_ID)
    expect(await portalIdByMemberId(db, LOCAL_PORTAL_MEMBER_ID)).toBeUndefined()
  })
})
