import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createApi, SUPPORTED_SCHEMA_VERSION } from '../src/api/handlers'
import { startServer, type NodeServer } from '../src/server/node'
import { MemoryStore } from '../src/store/memory'
import { PgStore, type Queryable } from '../src/store/pg'
import { buildDemo, SURVEY_KEY } from '../src/demo/seed'

/**
 * E2E по живому HTTP: реальный node:http сервер на свободном порту + fetch.
 * Проверяет адаптер (роутинг/JSON/лимиты) и весь конвейер «как в проде».
 */

let server: NodeServer
let base: string
let store: MemoryStore

beforeAll(async () => {
  store = await buildDemo(new MemoryStore())
  server = await startServer({ api: createApi({ store }), maxBodyBytes: 1024 })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await server.close()
})

function payload(nonce: string): Record<string, unknown> {
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    nonce,
    hp: '',
    surveyKey: SURVEY_KEY,
    versionNo: 2,
    answers: { q_nps: { values: ['n10'] }, q_csat: { values: ['s5'] }, q_liked: { values: ['quality'] } }
  }
}

async function post(path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
}

describe('node-адаптер: живой HTTP', () => {
  it('полный цикл: session → submit 200 → запись в сторе; replay того же nonce → 409', async () => {
    const before = (await store.listResponses()).length
    const s = await fetch(`${base}/api/session`)
    expect(s.status).toBe(200)
    const { nonce } = (await s.json()) as { nonce: string }
    expect(nonce).toBeTruthy()

    const ok = await post('/api/submit', JSON.stringify(payload(nonce)))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })
    expect((await store.listResponses()).length).toBe(before + 1)

    const replay = await post('/api/submit', JSON.stringify(payload(nonce)))
    expect(replay.status).toBe(409)
  })

  it('honeypot через HTTP → 400 generic', async () => {
    const r = await post('/api/submit', JSON.stringify({ hp: 'бот', что_угодно: 1 }))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ ok: false, error: 'Отклонено' })
  })

  it('кривой JSON → 400; тело больше лимита → 413', async () => {
    expect((await post('/api/submit', '{оборванный')).status).toBe(400)
    expect((await post('/api/submit', JSON.stringify({ pad: 'x'.repeat(2000) }))).status).toBe(413)
  })

  it('роутинг: неизвестный путь → 404, неверный метод → 405', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/session`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/submit`)).status).toBe(405)
    // query-string не ломает роутинг
    expect((await fetch(`${base}/api/session?x=1`)).status).toBe(200)
  })
})

describe('интеграция API ↔ PgStore (pglite)', () => {
  it('submit пишет в настоящий Postgres; ответ читается с серверным submittedAt', async () => {
    const pg = new PGlite()
    await pg.exec(readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8'))
    const db = pg as unknown as Queryable
    const portal = (
      await db.query<{ id: number }>(
        "insert into portal (member_id, domain, tokens) values ('m-api', 'api.b24', '{}'::jsonb) returning id"
      )
    ).rows[0]!.id
    const pgStore = await buildDemo(new PgStore(db, { portalId: portal, requireTransaction: true }))

    const fixed = new Date('2026-06-12T12:00:00.000Z')
    const api = createApi({ store: pgStore, now: () => fixed })
    const nonce = ((await api.session({ ip: 'a' })).body as { nonce: string }).nonce
    const r = await api.submit({ ip: 'a', body: payload(nonce) })
    expect(r.status).toBe(200)

    const saved = (await pgStore.listResponses()).at(-1)!
    expect(saved.submittedAt).toBe('2026-06-12T12:00:00.000Z')
    expect(saved.answers.find((a) => a.questionKey === 'q_nps')?.valueNumber).toBe(10)
    await pg.close()
  })
})
