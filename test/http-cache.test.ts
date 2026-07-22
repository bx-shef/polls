import { describe, expect, it } from 'vitest'
import { versionETag, etagMatches, cacheDecision } from '../src/api/http-cache'

describe('versionETag', () => {
  it('строит стабильный ETag в кавычках из (surveyKey, versionNo, schemaVersion)', () => {
    expect(versionETag('csat_postdeal', 2, 1)).toBe('"sv-csat_postdeal-2-s1"')
  })

  it('разные версии/схема → разные ETag (смена любого инвалидирует кэш)', () => {
    expect(versionETag('k', 1, 1)).not.toBe(versionETag('k', 2, 1))
    expect(versionETag('a', 1, 1)).not.toBe(versionETag('b', 1, 1))
    expect(versionETag('k', 1, 1)).not.toBe(versionETag('k', 1, 2)) // смена schema_version
  })

  it('экранирует спецсимволы ключа (кавычка/запятая) — валидный quoted-string, без ложного split', () => {
    expect(versionETag('a,b', 1, 1)).toBe('"sv-a%2Cb-1-s1"')
    expect(versionETag('a"b', 1, 1)).toBe('"sv-a%22b-1-s1"')
    // round-trip: наш собственный ETag со спецсимволом ключа матчится сам с собой (304 работает).
    const e = versionETag('a,b', 3, 1)
    expect(etagMatches(e, e)).toBe(true)
  })
})

describe('etagMatches', () => {
  const etag = '"sv-k-3-s1"'

  it('точное совпадение → true (условный GET → 304)', () => {
    expect(etagMatches('"sv-k-3-s1"', etag)).toBe(true)
  })

  it('несовпадение (другая версия/схема) → false (отдать 200 со свежим телом)', () => {
    expect(etagMatches('"sv-k-2-s1"', etag)).toBe(false)
    expect(etagMatches('"sv-k-3-s2"', etag)).toBe(false)
  })

  it('отсутствие/пустой заголовок → false', () => {
    expect(etagMatches(undefined, etag)).toBe(false)
    expect(etagMatches('', etag)).toBe(false)
  })

  it('`*` совпадает с любым', () => {
    expect(etagMatches('*', etag)).toBe(true)
  })

  it('список через запятую — совпадение с любым элементом (с пробелом и без)', () => {
    expect(etagMatches('"sv-k-1-s1", "sv-k-3-s1"', etag)).toBe(true)
    expect(etagMatches('"sv-k-1-s1","sv-k-3-s1"', etag)).toBe(true) // без пробела после запятой
    expect(etagMatches('  "sv-k-3-s1"  ', etag)).toBe(true) // лишние пробелы вокруг токена
    expect(etagMatches('"x", "y"', etag)).toBe(false)
  })

  it('дубли-запятые/пустой элемент — пустой токен не матчит, реальный матчит', () => {
    expect(etagMatches('"a",,"sv-k-3-s1"', etag)).toBe(true)
  })

  it('слабый префикс W/ — сравнение по opaque-значению (nginx gzip → W/)', () => {
    expect(etagMatches('W/"sv-k-3-s1"', etag)).toBe(true) // слабый клиент, сильный сервер
    expect(etagMatches('"sv-k-3-s1"', 'W/"sv-k-3-s1"')).toBe(true) // сильный клиент, слабый сервер
    expect(etagMatches('W/"sv-k-3-s1"', 'W/"sv-k-3-s1"')).toBe(true) // оба слабые
  })
})

describe('cacheDecision (решение условного GET из ApiResult)', () => {
  const body = (over = {}) => ({ ok: true, version: { surveyKey: 'k', versionNo: 3 }, schema_version: 1, ...over })

  it('200 + валидная версия → ETag выставлен, notModified по совпадению If-None-Match', () => {
    expect(cacheDecision(200, body(), undefined)).toEqual({ etag: '"sv-k-3-s1"', notModified: false })
    expect(cacheDecision(200, body(), '"sv-k-3-s1"')).toEqual({ etag: '"sv-k-3-s1"', notModified: true })
    expect(cacheDecision(200, body(), '"sv-k-2-s1"')).toEqual({ etag: '"sv-k-3-s1"', notModified: false })
  })

  it('не-200 (404/429/400/304) → некэшируемо (нет ETag, нет 304) даже при If-None-Match', () => {
    for (const s of [404, 429, 400, 500]) {
      expect(cacheDecision(s, { ok: false, error: 'x' }, '*')).toEqual({ notModified: false })
    }
  })

  it('неожиданная форма тела (нет version/versionNo/schema_version) → некэшируемо', () => {
    expect(cacheDecision(200, { ok: false, error: 'x' }, '*')).toEqual({ notModified: false })
    expect(cacheDecision(200, { version: { surveyKey: 'k' }, schema_version: 1 }, '*')).toEqual({ notModified: false })
    expect(cacheDecision(200, { version: { surveyKey: 'k', versionNo: 3 } }, '*')).toEqual({ notModified: false }) // нет schema_version
    expect(cacheDecision(200, null, '*')).toEqual({ notModified: false })
  })
})
