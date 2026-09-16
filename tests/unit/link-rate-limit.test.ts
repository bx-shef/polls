import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { addressKey, decideRateLimit, LIMITS, tokenKey, trustedAddress, WINDOW_SECONDS } from '../../server/domain/links/rate-limit'

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
  })

  it('считает портальные экраны отдельно от публичной анкеты', () => {
    // Пределы у них разные (120 против 60). На общем ключе офисный трафик сотрудников
    // выедал бы бюджет респондента с того же адреса, и анкета отвечала бы ему
    // «слишком много попыток» за чужую активность.
    expect(addressKey('203.0.113.7', sha256, 'portal'))
      .not.toBe(addressKey('203.0.113.7', sha256, 'public'))
    expect(tokenKey(sha256('x')).startsWith('rate:link:')).toBe(true)
  })
})

describe('чей адрес считаем', () => {
  it('берёт последний хоп, а не первый', () => {
    // Гвард от дыры, найденной панелью ревью PR #15. `$proxy_add_x_forwarded_for`
    // ДОПИСЫВАЕТ реальный адрес в конец, а `getRequestIP` из h3 берёт первый — то есть
    // тот, который прислал сам обращающийся. Считать по нему значит не считать вовсе:
    // предел по адресу снимается одной строкой в запросе.
    expect(trustedAddress('203.0.113.1, 198.51.100.9', '10.0.0.2')).toBe('198.51.100.9')
  })

  it('не верит подделанному значению, сколько бы его ни прислали', () => {
    const forged = '1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.9'

    expect(trustedAddress(forged, '10.0.0.2')).toBe('198.51.100.9')
  })

  it('работает и когда прокси заменяет заголовок, а не дописывает', () => {
    // Тогда в списке одно значение — первое и есть последнее.
    expect(trustedAddress('198.51.100.9', '10.0.0.2')).toBe('198.51.100.9')
  })

  it('без заголовка берёт адрес сокета', () => {
    // Прямое обращение в обход прокси: доверять нечему, кроме соединения.
    expect(trustedAddress(undefined, '198.51.100.9')).toBe('198.51.100.9')
    expect(trustedAddress('', '198.51.100.9')).toBe('198.51.100.9')
    expect(trustedAddress('  ,  ', '198.51.100.9')).toBe('198.51.100.9')
  })

  it('обрезает пробелы вокруг значения', () => {
    expect(trustedAddress('1.1.1.1 ,   198.51.100.9  ', '10.0.0.2')).toBe('198.51.100.9')
  })
})
