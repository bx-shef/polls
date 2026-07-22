import { describe, expect, it } from 'vitest'
import { versionETag, etagMatches } from '../src/api/http-cache'

describe('versionETag', () => {
  it('строит стабильный ETag в кавычках из (surveyKey, versionNo)', () => {
    expect(versionETag('csat_postdeal', 2)).toBe('"sv-csat_postdeal-2"')
  })

  it('разные версии → разные ETag (смена текущей версии инвалидирует кэш)', () => {
    expect(versionETag('k', 1)).not.toBe(versionETag('k', 2))
    expect(versionETag('a', 1)).not.toBe(versionETag('b', 1))
  })
})

describe('etagMatches', () => {
  const etag = '"sv-k-3"'

  it('точное совпадение → true (условный GET → 304)', () => {
    expect(etagMatches('"sv-k-3"', etag)).toBe(true)
  })

  it('несовпадение (другая версия) → false (отдать 200 со свежим телом)', () => {
    expect(etagMatches('"sv-k-2"', etag)).toBe(false)
  })

  it('отсутствие/пустой заголовок → false', () => {
    expect(etagMatches(undefined, etag)).toBe(false)
    expect(etagMatches('', etag)).toBe(false)
  })

  it('`*` совпадает с любым', () => {
    expect(etagMatches('*', etag)).toBe(true)
  })

  it('список через запятую — совпадение с любым элементом', () => {
    expect(etagMatches('"sv-k-1", "sv-k-3"', etag)).toBe(true)
    expect(etagMatches('"x", "y"', etag)).toBe(false)
  })

  it('слабый префикс W/ — сравнение по opaque-значению', () => {
    expect(etagMatches('W/"sv-k-3"', etag)).toBe(true)
    expect(etagMatches('W/"sv-k-3"', 'W/"sv-k-3"')).toBe(true)
  })
})
