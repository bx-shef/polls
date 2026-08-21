import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { DEV_PORTAL_ID, type PortalSession } from '../src/api/session'
import { draftV2, SURVEY_KEY } from '../src/demo/seed'

/**
 * Мультитенант (#47/#49) — ИСПОЛНЯЕМЫЙ гард на настоящей проводке Nitro.
 *
 * ⚠️ Проверяется ровно то, чего до сих пор не было: портал — ПАРАМЕТР запроса, а не состояние
 * процесса. Пока портал выбирался на процесс, каждый отдельный кусок выглядел рабочим — и именно
 * поэтому дефект был бы невидим: клиент одного заказчика заполнял бы анкету другого, ответ ложился
 * бы в чужие данные, а дашборд показывал бы чужие срезы с именами клиентов. Ни одного отказа,
 * ни одной строки в логе.
 *
 * Мокается один модуль — драйвер `pg`: вместо сокета к Postgres пул ходит в pglite. Всё остальное —
 * настоящие `server/utils/api.ts` и `server/utils/tenant.ts`: миграции, `PgStore`, резолверы.
 */
const pglite = new PGlite()
class FakePool {
  constructor(_o: unknown) {}
  on(): void {}
  async query(sql: string, params?: unknown[]) {
    if (params === undefined) { const r = await pglite.exec(sql); return r[r.length - 1] ?? { rows: [] } }
    return pglite.query(sql, params)
  }
  connect() { return Promise.resolve({ query: (s: string, p?: unknown[]) => pglite.query(s, p), release: () => {} }) }
}
vi.mock('pg', () => ({ default: { Pool: FakePool }, Pool: FakePool }))

/** Два портала-арендатора: `m-a` и `m-b`. Оба публикуют опрос с ОДНИМ И ТЕМ ЖЕ ключом. */
let portalA = 0
let portalB = 0

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://fake/fake'
  const { applySchema } = await import('./helpers/schema')
  await applySchema(pglite)
  const { PgStore } = await import('../src/store/pg')
  for (const member of ['m-a', 'm-b']) {
    const r = await pglite.query<{ id: number }>(
      `insert into portal (member_id, domain, tokens) values ($1, $2, '{}'::jsonb) returning id`,
      [member, `${member}.bitrix24.ru`]
    )
    const id = r.rows[0]!.id
    if (member === 'm-a') portalA = id; else portalB = id
    await new PgStore(pglite as never, { portalId: id }).publish(draftV2(), 2)
  }
})
afterAll(async () => { delete process.env.DATABASE_URL; await pglite.close() })

const session = (portalId: string): PortalSession => ({ portalId, exp: 2 ** 31, admin: true })

describe('публичный запрос: портал по токену приглашения', () => {
  it('токен выбирает СВОЙ портал, хотя ключ опроса общий', async () => {
    const { invitationsFor } = await import('../server/utils/api')
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    const inv = await (await invitationsFor(portalB)).create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 7 } }, new Date()
    )
    expect(await resolvePublicPortal(SURVEY_KEY, inv.token)).toEqual({ ok: true, portalId: portalB })
  }, 60_000)

  it('без токена ОБЩИЙ ключ обслужить нельзя — отказ, а не «первый попавшийся»', async () => {
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    expect(await resolvePublicPortal(SURVEY_KEY, undefined)).toEqual({ ok: false, reason: 'ambiguous' })
  }, 60_000)

  it('токен прислан, но мёртв → падаем в поиск по ключу (вердикт о ссылке ставит ядро)', async () => {
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    // Ключ общий, значит и здесь отказ — но по ПРИЧИНЕ неоднозначности ключа, а не «токен не найден»:
    // хеш токена уникален глобально, и «не найден» одинаково верно для любого портала.
    expect(await resolvePublicPortal(SURVEY_KEY, 'нет-такого-токена')).toEqual({ ok: false, reason: 'ambiguous' })
    // Ключа нет ни у кого → портала нет, дальше отвечает обычный путь (404 «опрос не найден»).
    expect(await resolvePublicPortal('нет-такого-опроса', 'нет-такого-токена')).toEqual({ ok: true, portalId: undefined })
  }, 60_000)
})

describe('стор и приглашения скоуплены порталом', () => {
  it('ответ, записанный за портал A, не виден порталу B', async () => {
    const { storeFor, useApiFor } = await import('../server/utils/api')
    const apiA = await useApiFor(portalA)
    const nonce = (await apiA.session({ ip: '10.0.0.1' })).body.nonce as string
    const r = await apiA.submit({
      ip: '10.0.0.1',
      body: {
        schema_version: 1, nonce, surveyKey: SURVEY_KEY, versionNo: 2,
        answers: { q_nps: { values: ['n9'] }, q_csat: { values: ['s4'] }, q_liked: { values: ['speed'] } }
      }
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    expect((await (await storeFor(portalA)).listResponses(SURVEY_KEY)).length).toBe(1)
    expect(
      (await (await storeFor(portalB)).listResponses(SURVEY_KEY)).length,
      'ответ портала A виден порталу B — tenant-изоляции нет'
    ).toBe(0)
  }, 60_000)

  it('приглашение портала B не резолвится стором портала A', async () => {
    const { invitationsFor } = await import('../server/utils/api')
    const inv = await (await invitationsFor(portalB)).create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 8 } }, new Date()
    )
    expect(await (await invitationsFor(portalB)).peek(inv.token, new Date())).toBeDefined()
    expect(
      await (await invitationsFor(portalA)).peek(inv.token, new Date()),
      'чужое приглашение видно из другого портала'
    ).toBeUndefined()
  }, 60_000)
})

describe('запрос из фрейма: портал по member_id сессии (#47)', () => {
  it('сессия портала B → числовой id портала B', async () => {
    const { resolveSessionPortal } = await import('../server/utils/tenant')
    expect(await resolveSessionPortal(session('m-b'))).toEqual({ ok: true, portalId: portalB })
  }, 60_000)

  it('портала с таким member_id больше нет → 401, а НЕ общий стор', async () => {
    // Подпись доказывает, чей это портал, но не то, что он ещё установлен. Фолбэк на общий стор в
    // этот момент показал бы сотруднику удалённого заказчика данные чужого портала.
    const { resolveSessionPortal } = await import('../server/utils/tenant')
    expect(await resolveSessionPortal(session('m-удалён'))).toEqual({ ok: false, status: 401 })
  }, 60_000)

  it('dev-открытый режим (авторизации нет) → портал не выбирается, общий стор', async () => {
    const { resolveSessionPortal } = await import('../server/utils/tenant')
    expect(await resolveSessionPortal(session(DEV_PORTAL_ID))).toEqual({ ok: true, portalId: undefined })
  }, 60_000)
})

describe('событийный путь: тенант по member_id', () => {
  it('стор и приглашения приходят от СВОЕГО портала', async () => {
    const { tenantByMemberId } = await import('../server/utils/tenant')
    const { invitationsFor } = await import('../server/utils/api')
    const t = await tenantByMemberId('m-b')
    expect(t).toBeDefined()
    const inv = await t!.invitations.create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 9 } }, new Date()
    )
    expect(await (await invitationsFor(portalB)).peek(inv.token, new Date())).toBeDefined()
    expect(await (await invitationsFor(portalA)).peek(inv.token, new Date())).toBeUndefined()
  }, 60_000)

  it('портала нет → undefined (триггерить некуда)', async () => {
    const { tenantByMemberId } = await import('../server/utils/tenant')
    expect(await tenantByMemberId('m-нет')).toBeUndefined()
  }, 60_000)
})
