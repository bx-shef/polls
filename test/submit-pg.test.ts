import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createApi, SUPPORTED_SCHEMA_VERSION, type Api } from '../src/api/handlers'
import { nullLogger } from '../src/obs/logger'
import { PgStore } from '../src/store/pg'
import { PgInvitationStore } from '../src/store/pg-invitation'
import type { Queryable } from '../src/store/types'
import { draftV2, SURVEY_KEY } from '../src/demo/seed'
import { applySchema } from './helpers/schema'

/**
 * `submit` на БОЕВОЙ ПАРЕ: `PgStore` + `PgInvitationStore` на настоящем Postgres (pglite).
 *
 * ⚠️ До этого весь путь приглашения на уровне API прогонялся только через in-memory реализации, а
 * интеграция API↔PgStore шла БЕЗ токена. После #170 это стало важно: одноразовость держит уже не
 * `consume` (атомарный `UPDATE`), а дедуп по токену в сторе ответов — частичный UNIQUE
 * `uq_response_invitation_token`. То есть барьер переехал в другую реализацию, и то, что он
 * действительно срабатывает в связке с `submit`, до сих пор не проверял ни один тест: сломай
 * `PgStore.addResponse` признак `stored`, и падал бы один сторовый тест, а HTTP-контракт молчал бы.
 */
let pglite: PGlite
let db: Queryable
beforeAll(async () => {
  pglite = new PGlite()
  await applySchema(pglite)
  db = pglite as unknown as Queryable
})
afterAll(async () => { await pglite.close() })

let seq = 0
async function freshPair(): Promise<{ api: Api; store: PgStore; invitations: PgInvitationStore; now: () => Date }> {
  const n = ++seq
  const r = await db.query<{ id: number }>(
    'insert into portal (member_id, domain, tokens) values ($1, $2, $3::jsonb) returning id',
    [`sub-m${n}`, `sub-p${n}.b24`, '{}']
  )
  const portalId = r.rows[0]!.id
  const store = new PgStore(db, { portalId })
  await store.publish(draftV2(), 2)
  const invitations = new PgInvitationStore(db, { portalId })
  const now = (): Date => new Date('2026-08-20T10:00:00.000Z')
  const api = createApi({ store, invitations, now, logger: nullLogger })
  return { api, store, invitations, now }
}

async function nonceOf(api: Api): Promise<string> {
  const s = await api.session({ ip: 'a' })
  return (s.body as { nonce: string }).nonce
}

function payload(nonce: string, token: string): Record<string, unknown> {
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    nonce,
    hp: '',
    surveyKey: SURVEY_KEY,
    versionNo: 2,
    invitation: token,
    answers: { q_nps: { values: ['n9'] }, q_csat: { values: ['s4'] }, q_liked: { values: ['speed'] } }
  }
}

describe('submit на паре PgStore + PgInvitationStore', () => {
  it('валидная ссылка → 200, ответ записан со снимком, ссылка погашена', async () => {
    const { api, store, invitations, now } = await freshPair()
    const inv = await invitations.create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 777, companyId: 5 } }, now()
    )
    expect((await api.submit({ ip: 'a', body: payload(await nonceOf(api), inv.token) })).status).toBe(200)
    const saved = await store.listResponses()
    expect(saved).toHaveLength(1)
    expect(saved[0]!.context).toMatchObject({ dealId: 777, companyId: 5 })
    expect(await invitations.peek(inv.token, now()), 'ссылка осталась годной после отправки').toBeUndefined()
  })

  it('повтор по той же ссылке → 409 «опрос пройден», ответ НЕ задваивается', async () => {
    const { api, store, invitations, now } = await freshPair()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 1 } }, now())
    expect((await api.submit({ ip: 'a', body: payload(await nonceOf(api), inv.token) })).status).toBe(200)
    const again = await api.submit({ ip: 'a', body: payload(await nonceOf(api), inv.token) })
    expect(again.status).toBe(409)
    expect((again.body as { error: string }).error).toContain('опрос пройден')
    expect(await store.listResponses()).toHaveLength(1)
  })

  it('ДВЕ ОДНОВРЕМЕННЫЕ отправки по одной ссылке → ровно один 200 и один 409, ответ один', async () => {
    // Барьер, на который переехала одноразовость: частичный UNIQUE по (portal_id, invitation_token).
    // У прежнего барьера (`consume` одним `UPDATE`) такой тест был; у нового не было.
    const { api, store, invitations, now } = await freshPair()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 2 } }, now())
    const [n1, n2] = [await nonceOf(api), await nonceOf(api)]
    const [a, b] = await Promise.all([
      api.submit({ ip: 'a', body: payload(n1, inv.token) }),
      api.submit({ ip: 'a', body: payload(n2, inv.token) })
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(await store.listResponses(), 'ответ по одной ссылке задвоился').toHaveLength(1)
  })

  it('ссылка от ДРУГОЙ версии → 409 mismatch, и токен НЕ сожжён', async () => {
    // Анти-DoS на утёкший токен: несовпавший пин не должен гасить чужое приглашение.
    const { api, invitations, now } = await freshPair()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 1, context: { dealId: 3 } }, now())
    const r = await api.submit({ ip: 'a', body: payload(await nonceOf(api), inv.token) })
    expect(r.status).toBe(409)
    expect(await invitations.peek(inv.token, now()), 'чужой пин сжёг приглашение').toBeDefined()
  })
})
