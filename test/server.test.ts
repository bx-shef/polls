import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createApi, SUPPORTED_SCHEMA_VERSION, type Api } from '../src/api/handlers'
import { MemoryNonceStore } from '../src/api/nonce'
import { SlidingWindowLimiter } from '../src/api/ratelimit'
import { failSafe, ipOf, pathOf, portOf, startServer, type NodeServer } from '../src/server/node'
import { MemoryStore } from '../src/store/memory'
import { nullLogger } from '../src/obs/logger'
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
    // before читается ВНУТРИ теста → ассерты не зависят от порядка соседних it
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

  it('роутинг: неизвестный путь → 404, неверный метод (POST/GET/HEAD/OPTIONS) → 405', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/session`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/session`, { method: 'HEAD' })).status).toBe(405)
    expect((await fetch(`${base}/api/submit`)).status).toBe(405)
    expect((await fetch(`${base}/api/submit`, { method: 'OPTIONS' })).status).toBe(405)
    // query-string не ломает роутинг
    expect((await fetch(`${base}/api/session?x=1`)).status).toBe(200)
  })

  it('rate-limit и переполнение nonce-стора доходят до клиента (429/503)', async () => {
    const limited = await startServer({
      api: createApi({
        store,
        limiter: new SlidingWindowLimiter({ limit: 1, windowMs: 60_000 })
      })
    })
    try {
      expect((await fetch(`http://127.0.0.1:${limited.port}/api/session`)).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${limited.port}/api/session`)).status).toBe(429)
    } finally {
      await limited.close()
    }

    const overflow = await startServer({
      api: createApi({ store, nonces: new MemoryNonceStore({ maxPending: 0 }) })
    })
    try {
      const r = await fetch(`http://127.0.0.1:${overflow.port}/api/session`)
      expect(r.status).toBe(503)
      expect(((await r.json()) as { error: string }).error).toMatch(/перегружен/)
    } finally {
      await overflow.close()
    }
  })

  it('GET /api/health → 200 { ok, ts }; POST /api/health → 405 (#5)', async () => {
    const r = await fetch(`${base}/api/health`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { ok: boolean; ts: string }
    expect(body.ok).toBe(true)
    expect(typeof body.ts).toBe('string')
    expect((await fetch(`${base}/api/health`, { method: 'POST' })).status).toBe(405)
  })

  it('каждый ответ несёт заголовок x-request-id (корреляция, #5)', async () => {
    const r = await fetch(`${base}/api/session`)
    expect(r.headers.get('x-request-id')).toBeTruthy()
  })

  it('логгер получает строку запроса: 200 → info, 4xx → warn (#5)', async () => {
    const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = []
    const cap =
      (level: string) =>
      (msg: string, fields?: Record<string, unknown>): void =>
        void lines.push({ level, msg, fields: fields ?? {} })
    const logger = { ...nullLogger, info: cap('info'), warn: cap('warn'), error: cap('error') }
    const srv = await startServer({ api: createApi({ store }), logger })
    try {
      // Порядок детерминирован микротаск-очередью: server-side .finally пишет в lines
      // ДО того, как loopback-ответ дойдёт до клиента (та же петля событий).
      await (await fetch(`http://127.0.0.1:${srv.port}/api/session`)).json()
      const ok = lines.find((l) => l.fields['path'] === '/api/session')
      expect(ok?.level).toBe('info')
      expect(ok?.msg).toBe('request')
      expect(ok?.fields['status']).toBe(200)
      expect(typeof ok?.fields['requestId']).toBe('string')

      await fetch(`http://127.0.0.1:${srv.port}/api/nope`).then((r) => r.text()) // 404
      const notFound = lines.find((l) => l.fields['path'] === '/api/nope')
      expect(notFound?.level).toBe('warn') // 4xx → warn
      expect(notFound?.fields['status']).toBe(404)
    } finally {
      await srv.close()
    }
  })

  it('health через адаптер при мёртвой БД → 503 (#5)', async () => {
    const store503 = await buildDemo(new MemoryStore())
    store503.ping = () => Promise.reject(new Error('db down'))
    const srv = await startServer({ api: createApi({ store: store503 }) })
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/health`)
      expect(r.status).toBe(503)
      expect(((await r.json()) as { ok: boolean }).ok).toBe(false)
    } finally {
      await srv.close()
    }
  })

  it('сломанный api → 500 через failSafe (процесс не падает); повторный close() → ошибка', async () => {
    const broken: Api = {
      session: () => Promise.reject(new Error('boom')),
      submit: () => Promise.reject(new Error('boom')),
      health: () => Promise.reject(new Error('boom'))
    }
    const srv = await startServer({ api: broken })
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/session`)
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ ok: false, error: 'Внутренняя ошибка' })
    await srv.close()
    await expect(srv.close()).rejects.toThrow() // сервер уже остановлен
  })
})

describe('node-адаптер: чистые helpers', () => {
  it('ipOf: сокет без адреса → "unknown"', () => {
    expect(ipOf({ socket: { remoteAddress: undefined } } as never)).toBe('unknown')
    expect(ipOf({ socket: { remoteAddress: '1.2.3.4' } } as never)).toBe('1.2.3.4')
  })

  it('pathOf: undefined/без query/с query', () => {
    expect(pathOf(undefined)).toBe('')
    expect(pathOf('/api/x')).toBe('/api/x')
    expect(pathOf('/api/x?a=1')).toBe('/api/x')
  })

  it('portOf: unix-socket (строка) и null → 0', () => {
    expect(portOf('/tmp/sock' as never)).toBe(0)
    expect(portOf(null)).toBe(0)
    expect(portOf({ address: '127.0.0.1', family: 'IPv4', port: 8080 })).toBe(8080)
  })

  it('failSafe: до заголовков — 500 JSON; после — destroy сокета', () => {
    const sent: unknown[] = []
    failSafe({
      headersSent: false,
      writeHead: (code: number) => void sent.push(code),
      end: (body: string) => void sent.push(body),
      destroy: () => void sent.push('destroy')
    } as never)
    expect(sent[0]).toBe(500)

    const after: unknown[] = []
    failSafe({
      headersSent: true,
      writeHead: () => void after.push('writeHead'),
      end: () => void after.push('end'),
      destroy: () => void after.push('destroy')
    } as never)
    expect(after).toEqual(['destroy'])
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
