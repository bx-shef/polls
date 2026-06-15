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
import { PortalTokenStore } from '../src/bitrix24/portal'
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
  })

  const now = new Date('2026-06-13T10:00:00.000Z')
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
})
