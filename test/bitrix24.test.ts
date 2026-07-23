import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { TokenCipher, encryptedBlobSchema, loadTokenKey } from '../src/bitrix24/crypto'
import { applySchema } from './helpers/schema'
import {
  Bitrix24OAuth,
  OAuthError,
  type HttpRequestInit,
  type HttpResponse,
  type OAuthTokens
} from '../src/bitrix24/oauth'
import { PortalTokenStore, resolveMemberIdByDomain } from '../src/bitrix24/portal'
import type { Queryable } from '../src/store/types'

const KEY_HEX = randomBytes(32).toString('hex')
const key = Buffer.from(KEY_HEX, 'hex')

const jsonRes = (ok: boolean, status: number, body: unknown): HttpResponse => ({
  ok,
  status,
  json: () => Promise.resolve(body)
})
const tokenBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: 'AT',
  refresh_token: 'RT',
  expires_in: 3600,
  member_id: 'm-1',
  domain: 'p.b24',
  client_endpoint: 'https://p.b24/rest/',
  ...over
})

describe('TokenCipher (AES-256-GCM)', () => {
  const cipher = new TokenCipher(key)

  it('seal/open round-trip; ciphertext не содержит открытого текста; blob помечен kid', () => {
    const secret = 'access_token_xyz|refresh_abc'
    const blob = cipher.seal(secret)
    expect(blob.alg).toBe('aes-256-gcm')
    expect(blob.kid).toBe(cipher.kid)
    expect(blob.kid).toMatch(/^[0-9a-f]{8}$/)
    expect(blob.ct).not.toContain('access_token')
    expect(cipher.open(blob)).toBe(secret)
  })

  it('каждый seal даёт новый IV/ciphertext (IV не переиспользуется)', () => {
    const a = cipher.seal('одно и то же')
    const b = cipher.seal('одно и то же')
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('подделка ciphertext или tag → ошибка (аутентификация GCM)', () => {
    const blob = cipher.seal('секрет')
    expect(() => cipher.open({ ...blob, ct: Buffer.from('подмена данных').toString('base64') })).toThrow()
    expect(() => cipher.open({ ...blob, tag: Buffer.alloc(16).toString('base64') })).toThrow()
  })

  it('чужой ключ не расшифровывает (kid mismatch — понятная ошибка)', () => {
    const blob = cipher.seal('секрет')
    expect(() => new TokenCipher(randomBytes(32)).open(blob)).toThrow(/другим ключом|kid/)
  })

  it('внешняя мутация переданного буфера не подменяет ключ шифра (копия)', () => {
    const k = randomBytes(32)
    const c = new TokenCipher(k)
    const blob = c.seal('данные')
    k.fill(0) // очистка исходного буфера после конструктора
    expect(c.open(blob)).toBe('данные')
  })

  it('ключ не 32 байта → ошибка конструктора', () => {
    expect(() => new TokenCipher(randomBytes(16))).toThrow(/32 байта/)
  })
})

describe('encryptedBlobSchema (валидация длины iv/tag)', () => {
  const cipher = new TokenCipher(key)

  it('корректный blob проходит', () => {
    expect(encryptedBlobSchema.safeParse(cipher.seal('x')).success).toBe(true)
  })

  it('короткий iv (не 12 байт) → reject', () => {
    const bad = { ...cipher.seal('x'), iv: Buffer.alloc(1).toString('base64') }
    expect(encryptedBlobSchema.safeParse(bad).success).toBe(false)
  })

  it('короткий tag (не 16 байт) → reject', () => {
    const bad = { ...cipher.seal('x'), tag: Buffer.alloc(4).toString('base64') }
    expect(encryptedBlobSchema.safeParse(bad).success).toBe(false)
  })

  it('пустой ct → reject', () => {
    const bad = { ...cipher.seal('x'), ct: '' }
    expect(encryptedBlobSchema.safeParse(bad).success).toBe(false)
  })
})

describe('loadTokenKey (startup-guard)', () => {
  it('валидный hex → Buffer 32 байта', () => {
    expect(loadTokenKey({ K: KEY_HEX }, 'K').length).toBe(32)
    expect(loadTokenKey({ NUXT_BITRIX_TOKEN_KEY: KEY_HEX }).length).toBe(32) // дефолтное имя
  })

  it('хвостовой перевод строки/пробелы вокруг валидного ключа → ок (trim)', () => {
    expect(loadTokenKey({ K: `  ${KEY_HEX}\n` }, 'K').length).toBe(32)
  })

  it('отсутствует/пустой → ошибка', () => {
    expect(() => loadTokenKey({}, 'K')).toThrow(/не задан/)
    expect(() => loadTokenKey({ K: '   ' }, 'K')).toThrow(/не задан/)
  })

  it('плейсхолдер/не hex → ошибка', () => {
    expect(() => loadTokenKey({ K: 'REPLACE_WITH__openssl_rand_hex_32' }, 'K')).toThrow(/64 hex/)
    expect(() => loadTokenKey({ K: 'abc' }, 'K')).toThrow(/64 hex/)
  })

  it('нулевой ключ → ошибка', () => {
    expect(() => loadTokenKey({ K: '0'.repeat(64) }, 'K')).toThrow(/нулевой/)
  })
})

describe('Bitrix24OAuth', () => {
  const now = new Date('2026-06-13T10:00:00.000Z')

  it('exchangeCode/refresh: параметры в POST-теле, парсит токены, считает expiresAt', async () => {
    const calls: { url: string; init?: HttpRequestInit }[] = []
    const oauth = new Bitrix24OAuth({
      clientId: 'cid',
      clientSecret: 'sec',
      now: () => now,
      fetch: (url, init) => {
        calls.push({ url, init })
        return Promise.resolve(jsonRes(true, 200, tokenBody()))
      }
    })
    const t = await oauth.exchangeCode('the-code')
    expect(t).toMatchObject({ memberId: 'm-1', accessToken: 'AT', refreshToken: 'RT', domain: 'p.b24' })
    expect(t.expiresAt).toBe('2026-06-13T11:00:00.000Z') // now + 3600s
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toContain('grant_type=authorization_code')
    expect(calls[0]!.init?.body).toContain('code=the-code')

    await oauth.refresh('RT-in')
    expect(calls[1]!.init?.body).toContain('grant_type=refresh_token')
    expect(calls[1]!.init?.body).toContain('refresh_token=RT-in')
  })

  it('client_secret уходит в теле POST, не в URL', async () => {
    let captured: { url: string; init?: HttpRequestInit } | undefined
    const oauth = new Bitrix24OAuth({
      clientId: 'cid',
      clientSecret: 'SUPER-SECRET',
      now: () => now,
      fetch: (url, init) => {
        captured = { url, init }
        return Promise.resolve(jsonRes(true, 200, tokenBody()))
      }
    })
    await oauth.refresh('RT')
    expect(captured!.url).toBe('https://oauth.bitrix.info/oauth/token/')
    expect(captured!.url).not.toContain('SUPER-SECRET') // секрета нет в URL
    expect(captured!.init?.body).toContain('client_secret=SUPER-SECRET') // он в теле
  })

  it('дефолты tokenUrl (официальный endpoint) и now (реальные часы)', async () => {
    let calledUrl = ''
    const oauth = new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 's',
      fetch: (url) => {
        calledUrl = url
        return Promise.resolve(jsonRes(true, 200, tokenBody()))
      }
    })
    const before = Date.now()
    const t = await oauth.refresh('RT')
    expect(calledUrl).toBe('https://oauth.bitrix.info/oauth/token/')
    const exp = new Date(t.expiresAt).getTime()
    expect(exp).toBeGreaterThanOrEqual(before + 3600_000)
    expect(exp).toBeLessThanOrEqual(Date.now() + 3600_000 + 5000)
  })

  it('дефолтный fetch = global fetch (мок глобала)', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(jsonRes(true, 200, tokenBody()))) as unknown as typeof fetch
    try {
      const oauth = new Bitrix24OAuth({ clientId: 'c', clientSecret: 's' })
      expect((await oauth.refresh('RT')).accessToken).toBe('AT')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('!ok → OAuthError с описанием Bitrix; секрет не утекает в сообщение', async () => {
    const oauth = new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 'super-secret',
      fetch: () => Promise.resolve(jsonRes(false, 401, { error: 'invalid_grant', error_description: 'token expired' }))
    })
    const e = await oauth.refresh('RT').then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(OAuthError)
    expect((e as OAuthError).status).toBe(401)
    expect((e as OAuthError).message).toMatch(/token expired/)
    expect((e as OAuthError).message).not.toContain('super-secret')
  })

  it('!ok с non-JSON телом (HTML от прокси) → «отказал», не «некорректный ответ»', async () => {
    const oauth = new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 's',
      fetch: () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) })
    })
    await expect(oauth.refresh('RT')).rejects.toThrow(/отказал: HTTP 502/)
  })

  it('аномально большой expires_in → OAuthError (не RangeError)', async () => {
    const oauth = new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 's',
      fetch: () => Promise.resolve(jsonRes(true, 200, tokenBody({ expires_in: 9_999_999_999_999 })))
    })
    await expect(oauth.refresh('RT')).rejects.toThrow(/неполные токены/)
  })

  it('сеть/JSON/неполные токены → OAuthError', async () => {
    const mk = (fetch: ConstructorParameters<typeof Bitrix24OAuth>[0]['fetch']): Bitrix24OAuth =>
      new Bitrix24OAuth({ clientId: 'c', clientSecret: 's', fetch })
    await expect(mk(() => Promise.resolve(jsonRes(false, 500, {}))).refresh('R')).rejects.toThrow(/отказал: HTTP 500/)
    await expect(mk(() => Promise.reject(new Error('ECONNREFUSED'))).refresh('R')).rejects.toThrow(/Сеть недоступна/)
    await expect(
      mk(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad')) })).refresh('R')
    ).rejects.toThrow(/Некорректный ответ/)
    await expect(mk(() => Promise.resolve(jsonRes(true, 200, { access_token: 'AT' }))).refresh('R')).rejects.toThrow(
      /неполные токены/
    )
  })
})

describe('PortalTokenStore (pglite)', () => {
  const cipher = new TokenCipher(key)
  let pg: PGlite
  let db: Queryable
  let store: PortalTokenStore

  beforeAll(async () => {
    pg = new PGlite()
    await applySchema(pg)
    db = pg as unknown as Queryable
    store = new PortalTokenStore(db, cipher)
  })
  afterAll(async () => {
    await pg.close()
  })
  // Изоляция: каждый тест стартует с пустой таблицей portal (без порядковой связности).
  beforeEach(async () => {
    await db.query('delete from portal')
    await db.query('delete from portal_tombstone')
  })

  const now = new Date('2026-06-13T10:00:00.000Z')
  const DAY_MS = 86_400_000
  const noCall = new Bitrix24OAuth({
    clientId: 'c',
    clientSecret: 's',
    fetch: () => Promise.reject(new Error('refresh не должен вызываться'))
  })
  const refreshTo = (over: Record<string, unknown>): Bitrix24OAuth =>
    new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 's',
      now: () => now,
      fetch: () => Promise.resolve(jsonRes(true, 200, tokenBody(over)))
    })

  const tokens = (over: Partial<OAuthTokens> = {}): OAuthTokens => ({
    memberId: 'm-1',
    accessToken: 'AT-1',
    refreshToken: 'RT-1',
    expiresAt: '2026-06-13T11:00:00.000Z',
    domain: 'p.b24',
    ...over
  })

  it('save → load round-trip; в БД токены ЗАШИФРОВАНЫ (не открытым текстом)', async () => {
    await store.save(tokens())
    expect(await store.load('m-1')).toMatchObject({ accessToken: 'AT-1', refreshToken: 'RT-1', memberId: 'm-1' })
    const raw = await db.query<{ t: string }>('select tokens::text as t from portal where member_id = $1', ['m-1'])
    expect(raw.rows[0]!.t).not.toContain('AT-1') // токена нет в открытом виде
    expect(raw.rows[0]!.t).toContain('aes-256-gcm')
  })

  it('save повторно (upsert по member_id) обновляет токены и domain, не плодя строки', async () => {
    await store.save(tokens({ accessToken: 'v1', domain: 'old.b24' }))
    await store.save(tokens({ accessToken: 'v2', domain: 'new.b24' }))
    expect((await store.load('m-1'))?.accessToken).toBe('v2')
    const r = await db.query<{ n: number; domain: string }>(
      'select count(*)::int as n, max(domain) as domain from portal where member_id = $1',
      ['m-1']
    )
    expect(r.rows[0]!.n).toBe(1)
    expect(r.rows[0]!.domain).toBe('new.b24') // domain обновлён на конфликте
  })

  it('load неизвестного портала → undefined', async () => {
    expect(await store.load('нет-такого')).toBeUndefined()
  })

  it('save: токены без domain → пустая строка (колонка NOT NULL)', async () => {
    await store.save(tokens({ memberId: 'm-nodom', domain: undefined }))
    const r = await db.query<{ domain: string }>('select domain from portal where member_id = $1', ['m-nodom'])
    expect(r.rows[0]!.domain).toBe('')
  })

  it('load: повреждённый blob → OAuthError', async () => {
    await db.query(`insert into portal (member_id, domain, tokens) values ('m-bad', 'd', $1)`, ['{"foo":1}'])
    await expect(store.load('m-bad')).rejects.toThrow(OAuthError)
  })

  it('load: токены, зашифрованные другим ключом → OAuthError (kid mismatch)', async () => {
    await store.save(tokens({ memberId: 'm-otherkey' }))
    const otherStore = new PortalTokenStore(db, new TokenCipher(randomBytes(32)))
    await expect(otherStore.load('m-otherkey')).rejects.toThrow(OAuthError)
  })

  it('accessToken: свежий токен — без refresh', async () => {
    await store.save(tokens({ memberId: 'm-fresh', expiresAt: '2026-06-13T11:00:00.000Z' }))
    expect(await store.accessToken('m-fresh', noCall, now)).toBe('AT-1')
    expect(await store.accessToken('нет', noCall, now)).toBeUndefined()
  })

  it('accessToken: протухший (с запасом) — refresh + пере-сохранение зашифрованным', async () => {
    await store.save(tokens({ memberId: 'm-stale', accessToken: 'OLD', expiresAt: '2026-06-13T10:00:30.000Z' }))
    const oauth = refreshTo({ member_id: 'm-stale', access_token: 'NEW', refresh_token: 'RT-NEW' })
    expect(await store.accessToken('m-stale', oauth, now)).toBe('NEW')
    expect((await store.load('m-stale'))?.accessToken).toBe('NEW')
  })

  it('accessToken: граница expiresAt - SKEW == now → рефрешит; +1с → свежий', async () => {
    // now=10:00:00, SKEW=60с. expiresAt=10:01:00 → ровно на границе → refresh.
    await store.save(tokens({ memberId: 'm-bnd', accessToken: 'OLD', expiresAt: '2026-06-13T10:01:00.000Z' }))
    const oauth = refreshTo({ member_id: 'm-bnd', access_token: 'NEW', refresh_token: 'RT-NEW' })
    expect(await store.accessToken('m-bnd', oauth, now)).toBe('NEW')
    // expiresAt=10:01:01 → запас > SKEW → свежий, refresh не зовётся
    await store.save(tokens({ memberId: 'm-fresh2', accessToken: 'KEEP', expiresAt: '2026-06-13T10:01:01.000Z' }))
    expect(await store.accessToken('m-fresh2', noCall, now)).toBe('KEEP')
  })

  it('accessToken: ошибка refresh пробрасывается как OAuthError', async () => {
    await store.save(tokens({ memberId: 'm-thr', expiresAt: '2026-06-13T10:00:30.000Z' }))
    const failing = new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 's',
      fetch: () => Promise.resolve(jsonRes(false, 401, { error_description: 'expired' }))
    })
    await expect(store.accessToken('m-thr', failing, now)).rejects.toThrow(OAuthError)
  })

  it('accessToken: refresh вернул чужой member_id → OAuthError (без записи в чужой tenant)', async () => {
    await store.save(tokens({ memberId: 'm-mm', accessToken: 'OLD', expiresAt: '2026-06-13T10:00:30.000Z' }))
    const oauth = refreshTo({ member_id: 'OTHER', access_token: 'X', refresh_token: 'Y' })
    await expect(store.accessToken('m-mm', oauth, now)).rejects.toThrow(/чужого портала/)
    expect((await store.load('m-mm'))?.accessToken).toBe('OLD') // токен m-mm не затронут
  })

  // ── Lifecycle-hardening (миграция 0004, docs/project-map.md §2) ──
  const epochOf = async (memberId: string): Promise<number> => {
    const r = await db.query<{ e: string }>(
      'select extract(epoch from updated_at)::bigint as e from portal where member_id = $1',
      [memberId]
    )
    return Number(r.rows[0]!.e)
  }

  it('save: штампует updated_at из opts.now', async () => {
    await store.save(tokens({ memberId: 'm-ts' }), { now })
    expect(await epochOf('m-ts')).toBe(Math.floor(now.getTime() / 1000))
  })

  it('accessToken refresh обновляет updated_at (updateOnRefresh, UPDATE-only)', async () => {
    const stale = new Date(now.getTime() - 100 * DAY_MS)
    await store.save(tokens({ memberId: 'm-ref', expiresAt: '2026-06-13T10:00:30.000Z' }), { now: stale })
    const oauth = refreshTo({ member_id: 'm-ref', access_token: 'NEW', refresh_token: 'RT-NEW' })
    await store.accessToken('m-ref', oauth, now)
    expect(await epochOf('m-ref')).toBe(Math.floor(now.getTime() / 1000)) // штамп сдвинут на now
  })

  it('updateOnRefresh: UPDATE-only — НЕ воскрешает удалённый портал (возвращает false)', async () => {
    await store.save(tokens({ memberId: 'm-del' }))
    await store.deletePortal('m-del', 100)
    const persisted = await store.updateOnRefresh(tokens({ memberId: 'm-del', accessToken: 'NEW', domain: undefined }))
    expect(persisted).toBe(false) // строки нет — UPDATE 0 строк
    expect(await store.load('m-del')).toBeUndefined()
  })

  it('updateOnRefresh: существующий портал — обновляет и возвращает true', async () => {
    await store.save(tokens({ memberId: 'm-upd', accessToken: 'OLD' }))
    const persisted = await store.updateOnRefresh(tokens({ memberId: 'm-upd', accessToken: 'NEW' }))
    expect(persisted).toBe(true)
    expect((await store.load('m-upd'))?.accessToken).toBe('NEW')
  })

  it('deletePortal: каскадно чистит зависимые данные портала (survey_group/app_user)', async () => {
    await store.save(tokens({ memberId: 'm-casc' }))
    const pid = (await db.query<{ id: string }>('select id from portal where member_id = $1', ['m-casc'])).rows[0]!.id
    // Прямые дети portal(id) — именно они без on-delete-cascade и блокировали бы `delete portal`.
    await db.query('insert into app_user (portal_id, b24_user_id) values ($1, 7)', [pid])
    await db.query(`insert into survey_group (portal_id, title) values ($1, 'g')`, [pid])
    await store.deletePortal('m-casc', 999)
    expect(await store.load('m-casc')).toBeUndefined()
    const g = await db.query('select 1 from survey_group where portal_id = $1', [pid])
    const u = await db.query('select 1 from app_user where portal_id = $1', [pid])
    expect(g.rows.length).toBe(0)
    expect(u.rows.length).toBe(0)
  })

  it('deletePortal: работает на драйвере без transaction (последовательные запросы)', async () => {
    const noTx: Queryable = { query: (sql, params) => db.query(sql, params) } // без transaction
    const s2 = new PortalTokenStore(noTx, cipher)
    await s2.save(tokens({ memberId: 'm-notx' }))
    await s2.deletePortal('m-notx', 100)
    expect(await s2.load('m-notx')).toBeUndefined()
  })

  it('accessToken: портал удалён во время refresh → undefined (не отдаёт токен «мёртвого»)', async () => {
    await store.save(tokens({ memberId: 'm-race', accessToken: 'OLD', expiresAt: '2026-06-13T10:00:30.000Z' }))
    // refresh как сайд-эффект удаляет портал → updateOnRefresh увидит 0 строк → accessToken → undefined.
    const racingOauth = new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 's',
      now: () => now,
      fetch: async () => {
        await db.query(`delete from portal where member_id = 'm-race'`)
        return jsonRes(true, 200, tokenBody({ member_id: 'm-race', access_token: 'NEW', refresh_token: 'RT-NEW' }))
      }
    })
    expect(await store.accessToken('m-race', racingOauth, now)).toBeUndefined()
    expect(await store.load('m-race')).toBeUndefined() // остался удалён (не воскрешён)
  })

  it('deletePortal: пишет тумбстоун и удаляет строку портала', async () => {
    await store.save(tokens({ memberId: 'm-u' }))
    await store.deletePortal('m-u', 500)
    expect(await store.load('m-u')).toBeUndefined()
    const t = await db.query<{ deleted_ts: string }>(
      'select deleted_ts from portal_tombstone where member_id = $1',
      ['m-u']
    )
    expect(Number(t.rows[0]!.deleted_ts)).toBe(500)
  })

  it('deletePortal: повторная доставка хранит НОВЕЙШИЙ uninstall (greatest)', async () => {
    await store.deletePortal('m-g', 100)
    await store.deletePortal('m-g', 50) // устаревший ретрай
    const t = await db.query<{ deleted_ts: string }>(
      'select deleted_ts from portal_tombstone where member_id = $1',
      ['m-g']
    )
    expect(Number(t.rows[0]!.deleted_ts)).toBe(100)
  })

  it('save с eventTs: устаревший install (ts ≤ тумбстоун) НЕ воскрешает портал', async () => {
    await store.deletePortal('m-b', 1000)
    const wrote = await store.save(tokens({ memberId: 'm-b' }), { eventTs: 1000 }) // 1000 >= 1000 → блок
    expect(wrote).toBe(false)
    expect(await store.load('m-b')).toBeUndefined()
  })

  it('save с eventTs: глубоко устаревший install (ts < тумбстоун) — тоже блок', async () => {
    await store.deletePortal('m-b2', 1000)
    const wrote = await store.save(tokens({ memberId: 'm-b2' }), { eventTs: 500 }) // 1000 >= 500 → блок
    expect(wrote).toBe(false)
    expect(await store.load('m-b2')).toBeUndefined()
  })

  it('save БЕЗ eventTs: гард opt-in — игнорирует существующий тумбстоун (текущий install.post.ts)', async () => {
    await store.deletePortal('m-noguard', 1000)
    const wrote = await store.save(tokens({ memberId: 'm-noguard' })) // без eventTs → гард выключен
    expect(wrote).toBe(true)
    expect(await store.load('m-noguard')).toMatchObject({ memberId: 'm-noguard' })
  })

  it('save с eventTs: настоящая переустановка (ts > тумбстоун) проходит и чистит тумбстоун', async () => {
    await store.deletePortal('m-r', 1000)
    const wrote = await store.save(tokens({ memberId: 'm-r' }), { eventTs: 2000 })
    expect(wrote).toBe(true)
    expect(await store.load('m-r')).toMatchObject({ memberId: 'm-r' })
    const t = await db.query('select 1 from portal_tombstone where member_id = $1', ['m-r'])
    expect(t.rows.length).toBe(0) // тумбстоун (1000 < 2000) вычищен
  })

  it('listNearExpiry: только порталы в полосе у истечения refresh_token', async () => {
    await store.save(tokens({ memberId: 'm-old' }), { now: new Date(now.getTime() - 178 * DAY_MS) }) // в полосе
    await store.save(tokens({ memberId: 'm-recent' }), { now: new Date(now.getTime() - 10 * DAY_MS) }) // свежий
    await store.save(tokens({ memberId: 'm-dead' }), { now: new Date(now.getTime() - 181 * DAY_MS) }) // за TTL
    expect(await store.listNearExpiry(now)).toEqual(['m-old'])
  })

  it('listNearExpiry: границы полосы — верхняя (177д) исключена, нижняя (180д) включена', async () => {
    await store.save(tokens({ memberId: 'm-edge-hi' }), { now: new Date(now.getTime() - 177 * DAY_MS) }) // == cutoffOld → искл.
    await store.save(tokens({ memberId: 'm-edge-lo' }), { now: new Date(now.getTime() - 180 * DAY_MS) }) // == ttlFloor → вкл.
    expect(await store.listNearExpiry(now)).toEqual(['m-edge-lo'])
  })

  it('listNearExpiry: сортировка по возрасту (старейший первым) + кап батча (limit)', async () => {
    await store.save(tokens({ memberId: 'm-a' }), { now: new Date(now.getTime() - 178 * DAY_MS) })
    await store.save(tokens({ memberId: 'm-b' }), { now: new Date(now.getTime() - 179 * DAY_MS) }) // старейший
    await store.save(tokens({ memberId: 'm-c' }), { now: new Date(now.getTime() - 177.5 * DAY_MS) })
    // limit=2 → два СТАРЕЙШИХ по возрастанию updated_at: m-b (179д), затем m-a (178д)
    expect(await store.listNearExpiry(now, { limit: 2 })).toEqual(['m-b', 'm-a'])
  })

  it('listNearExpiry: кастомные ttlDays/skewDays переопределяют дефолты', async () => {
    // ttl=30, skew=5 → полоса [now-30д, now-25д). 27д — внутри, 10д — свежий, 40д — за TTL.
    await store.save(tokens({ memberId: 'm-c27' }), { now: new Date(now.getTime() - 27 * DAY_MS) })
    await store.save(tokens({ memberId: 'm-c10' }), { now: new Date(now.getTime() - 10 * DAY_MS) })
    await store.save(tokens({ memberId: 'm-c40' }), { now: new Date(now.getTime() - 40 * DAY_MS) })
    expect(await store.listNearExpiry(now, { ttlDays: 30, skewDays: 5 })).toEqual(['m-c27'])
  })
})

describe('resolveMemberIdByDomain (pglite) — резолвер domain → member_id (#47/#49)', () => {
  let pg: PGlite
  let db: Queryable

  beforeAll(async () => {
    pg = new PGlite()
    await applySchema(pg)
    db = pg as unknown as Queryable
    // Две установки (как после OAuth-install): домен → member_id.
    await db.query(
      `insert into portal (member_id, domain, tokens) values
         ('m-acme', 'acme.bitrix24.ru', '{}'::jsonb),
         ('m-shop', 'shop.bitrix24.com.br', '{}'::jsonb)`
    )
  })
  afterAll(async () => {
    await pg.close()
  })

  it('установленный домен → его member_id (авторитетный источник, не из POST)', async () => {
    expect(await resolveMemberIdByDomain(db, 'acme.bitrix24.ru')).toBe('m-acme')
    expect(await resolveMemberIdByDomain(db, 'shop.bitrix24.com.br')).toBe('m-shop')
  })

  it('неизвестный домен → undefined (портал не установлен ⇒ handshake fail-closed)', async () => {
    expect(await resolveMemberIdByDomain(db, 'evil.bitrix24.ru')).toBeUndefined()
  })
})
