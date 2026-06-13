import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { TokenCipher, loadTokenKey } from '../src/bitrix24/crypto'
import { Bitrix24OAuth, OAuthError, type HttpResponse, type OAuthTokens } from '../src/bitrix24/oauth'
import { PortalTokenStore } from '../src/bitrix24/portal'
import type { Queryable } from '../src/store/pg'

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

  it('seal/open round-trip; ciphertext не содержит открытого текста', () => {
    const secret = 'access_token_xyz|refresh_abc'
    const blob = cipher.seal(secret)
    expect(blob.alg).toBe('aes-256-gcm')
    expect(blob.ct).not.toContain('access_token')
    expect(cipher.open(blob)).toBe(secret)
  })

  it('подделка ciphertext или tag → ошибка (аутентификация GCM)', () => {
    const blob = cipher.seal('секрет')
    expect(() => cipher.open({ ...blob, ct: Buffer.from('подмена данных').toString('base64') })).toThrow()
    expect(() => cipher.open({ ...blob, tag: Buffer.alloc(16).toString('base64') })).toThrow()
  })

  it('чужой ключ не расшифровывает', () => {
    const blob = cipher.seal('секрет')
    expect(() => new TokenCipher(randomBytes(32)).open(blob)).toThrow()
  })

  it('ключ не 32 байта → ошибка конструктора', () => {
    expect(() => new TokenCipher(randomBytes(16))).toThrow(/32 байта/)
  })
})

describe('loadTokenKey (startup-guard)', () => {
  it('валидный hex → Buffer 32 байта', () => {
    expect(loadTokenKey({ K: KEY_HEX }, 'K').length).toBe(32)
    expect(loadTokenKey({ NUXT_BITRIX_TOKEN_KEY: KEY_HEX }).length).toBe(32) // дефолтное имя
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

  it('exchangeCode/refresh: парсит токены, считает expiresAt из expires_in', async () => {
    const calls: string[] = []
    const oauth = new Bitrix24OAuth({
      clientId: 'cid',
      clientSecret: 'sec',
      now: () => now,
      fetch: (url) => {
        calls.push(url)
        return Promise.resolve(jsonRes(true, 200, tokenBody()))
      }
    })
    const t = await oauth.exchangeCode('the-code')
    expect(t).toMatchObject({ memberId: 'm-1', accessToken: 'AT', refreshToken: 'RT', domain: 'p.b24' })
    expect(t.expiresAt).toBe('2026-06-13T11:00:00.000Z') // now + 3600s
    expect(calls[0]).toContain('grant_type=authorization_code')
    expect(calls[0]).toContain('code=the-code')

    await oauth.refresh('RT-in')
    expect(calls[1]).toContain('grant_type=refresh_token')
    expect(calls[1]).toContain('refresh_token=RT-in')
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
    expect(calledUrl).toContain('https://oauth.bitrix.info/oauth/token/')
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

  it('!ok без error_description → generic; сеть/JSON/неполные токены → OAuthError', async () => {
    const mk = (fetch: ConstructorParameters<typeof Bitrix24OAuth>[0]['fetch']): Bitrix24OAuth =>
      new Bitrix24OAuth({ clientId: 'c', clientSecret: 's', fetch })
    await expect(mk(() => Promise.resolve(jsonRes(false, 500, {}))).refresh('R')).rejects.toThrow(/отказал: ошибка/)
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
  const migration = readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8')
  const cipher = new TokenCipher(key)
  let pg: PGlite
  let db: Queryable
  let store: PortalTokenStore

  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(migration)
    db = pg as unknown as Queryable
    store = new PortalTokenStore(db, cipher)
  })
  afterAll(async () => {
    await pg.close()
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

  it('save повторно (upsert по member_id) обновляет токены, не плодя строки', async () => {
    await store.save(tokens({ memberId: 'm-up', accessToken: 'v1' }))
    await store.save(tokens({ memberId: 'm-up', accessToken: 'v2' }))
    expect((await store.load('m-up'))?.accessToken).toBe('v2')
    const c = await db.query<{ n: number }>('select count(*)::int as n from portal where member_id = $1', ['m-up'])
    expect(c.rows[0]!.n).toBe(1)
  })

  it('load неизвестного портала → undefined', async () => {
    expect(await store.load('нет-такого')).toBeUndefined()
  })

  it('accessToken: свежий — без refresh; протухший (с запасом) — refresh + пере-сохранение', async () => {
    const now = new Date('2026-06-13T10:00:00.000Z')
    const noCall = new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 's',
      fetch: () => Promise.reject(new Error('refresh не должен вызываться'))
    })

    await store.save(tokens({ memberId: 'm-fresh', expiresAt: '2026-06-13T11:00:00.000Z' }))
    expect(await store.accessToken('m-fresh', noCall, now)).toBe('AT-1')

    // протухает в пределах REFRESH_SKEW (60с) → должен рефрешнуться
    await store.save(tokens({ memberId: 'm-stale', accessToken: 'OLD', expiresAt: '2026-06-13T10:00:30.000Z' }))
    const oauth = new Bitrix24OAuth({
      clientId: 'c',
      clientSecret: 's',
      now: () => now,
      fetch: () => Promise.resolve(jsonRes(true, 200, tokenBody({ member_id: 'm-stale', access_token: 'NEW', refresh_token: 'RT-NEW' })))
    })
    expect(await store.accessToken('m-stale', oauth, now)).toBe('NEW')
    expect((await store.load('m-stale'))?.accessToken).toBe('NEW') // пере-сохранён зашифрованным

    expect(await store.accessToken('нет', noCall, now)).toBeUndefined()
  })
})
