import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { addressKey, decideRateLimit, LIMITS, tokenKey, WINDOW_SECONDS } from '../../server/domain/links/rate-limit'

/**
 * Ограничение частоты на публичной странице. Раньше оно жило зонами nginx и исчезло вместе
 * с ним при переходе на общий хост — то есть это не «ещё одна проверка», а восстановление
 * защиты, которой какое-то время не было.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

describe('решение по счётчикам', () => {
  it('пускает, пока пределы не превышены', () => {
    expect(decideRateLimit({ perAddress: LIMITS.perAddress, perToken: LIMITS.perToken })).toEqual({ allow: true })
  })

  it('отказывает по адресу на превышении', () => {
    expect(decideRateLimit({ perAddress: LIMITS.perAddress + 1, perToken: 1 }))
      .toEqual({ allow: false, by: 'address', retryAfterSeconds: WINDOW_SECONDS })
  })

  it('отказывает по токену, даже когда адрес в порядке', () => {
    // Токен уже известен, и долбят в одну анкету с разных адресов — защита по адресу
    // здесь не срабатывает вовсе, ради этого второй ключ и заведён.
    expect(decideRateLimit({ perAddress: 1, perToken: LIMITS.perToken + 1 }))
      .toEqual({ allow: false, by: 'token', retryAfterSeconds: WINDOW_SECONDS })
  })

  it('на превышении обоих называет адрес', () => {
    // При переборе чужих токенов общее у попыток — именно адрес, и назвать стоит его.
    expect(decideRateLimit({ perAddress: LIMITS.perAddress + 1, perToken: LIMITS.perToken + 1 }))
      .toMatchObject({ allow: false, by: 'address' })
  })

  it('держит предел по адресу выше, чем по токену', () => {
    // За одним адресом может сидеть офис клиента: несколько человек, открывших свои анкеты
    // одновременно, — обычный день. А свою анкету не открывают двадцать раз в минуту.
    expect(LIMITS.perAddress).toBeGreaterThan(LIMITS.perToken)
  })

  it('слушается переданных пределов, а не только своих', () => {
    expect(decideRateLimit({ perAddress: 3, perToken: 0 }, 5, { perAddress: 2, perToken: 99 }))
      .toEqual({ allow: false, by: 'address', retryAfterSeconds: 5 })
  })
})

describe('ключи счётчиков', () => {
  it('не кладёт адрес посетителя в ключ как есть', () => {
    // IP постороннего человека — персональные данные. Для счёта достаточно различать
    // адреса, а не знать их, поэтому в Redis уезжает хеш.
    const key = addressKey('203.0.113.7', sha256)

    expect(key).not.toContain('203.0.113.7')
    expect(key).toBe(`rate:addr:${sha256('203.0.113.7')}`)
  })

  it('считает один адрес одним, как бы его ни записали', () => {
    // Один и тот же клиент приходит то как `::ffff:1.2.3.4`, то как `1.2.3.4` —
    // без нормализации у него было бы два счёта вместо одного, то есть двойной лимит.
    const plain = addressKey('203.0.113.7', sha256)

    expect(addressKey('::ffff:203.0.113.7', sha256)).toBe(plain)
    expect(addressKey('  203.0.113.7  ', sha256)).toBe(plain)
    expect(addressKey('::FFFF:203.0.113.7', sha256)).toBe(plain)
  })

  it('различает разные адреса', () => {
    expect(addressKey('203.0.113.7', sha256)).not.toBe(addressKey('203.0.113.8', sha256))
  })

  it('не кладёт токен в ключ — только его хеш', () => {
    const hash = sha256('секрет')

    expect(tokenKey(hash)).toBe(`rate:link:${hash}`)
  })

  it('разводит счётчики адреса и токена по разным пространствам', () => {
    // Иначе адрес, совпавший с хешем токена, обнулил бы чужой счёт.
    expect(addressKey('203.0.113.7', sha256).startsWith('rate:addr:')).toBe(true)
    expect(tokenKey(sha256('x')).startsWith('rate:link:')).toBe(true)
  })
})
