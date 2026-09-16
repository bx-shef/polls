import { describe, expect, it } from 'vitest'
import {
  DENIAL_MESSAGES,
  decideLinkAccess,
  statusAfterOpen,
  type LinkDenial,
  type LinkStatus,
} from '../../server/domain/links/access'

/**
 * Статусная машина ссылки. Ошибка здесь не падает и не шумит — она либо пускает чужого
 * в анкету, либо не пускает своего, и оба случая видит посторонний человек, а не мы.
 */

const NOW = new Date('2026-09-16T12:00:00Z')
const TOMORROW = new Date('2026-09-17T12:00:00Z')
const YESTERDAY = new Date('2026-09-15T12:00:00Z')

describe('кого пускаем в анкету', () => {
  it.each<[LinkStatus]>([['sent'], ['opened']])('пускает по действующей ссылке в статусе %s', (status) => {
    expect(decideLinkAccess({ status, expiresAt: TOMORROW }, NOW)).toEqual({ allow: true, status, answered: false })
  })

  it('не пускает по выпущенной, но не отправленной ссылке', () => {
    // Такая ссылка ещё не у клиента. Если по ней пришли — токен утёк или угадан,
    // и срок тут ни при чём.
    expect(decideLinkAccess({ status: 'created', expiresAt: TOMORROW }, NOW))
      .toEqual({ allow: false, reason: 'not-sent' })
  })

  it.each<[LinkStatus, LinkDenial]>([
    ['completed', 'completed'],
    ['revoked', 'revoked'],
    ['expired', 'expired'],
  ])('не пускает в статусе %s', (status, reason) => {
    expect(decideLinkAccess({ status, expiresAt: TOMORROW }, NOW)).toEqual({ allow: false, reason })
  })

  it('не пускает по истёкшему сроку, даже если статус рабочий', () => {
    expect(decideLinkAccess({ status: 'sent', expiresAt: YESTERDAY }, NOW))
      .toEqual({ allow: false, reason: 'expired' })
  })

  it('считает истёкшей ссылку, срок которой наступил ровно сейчас', () => {
    // Граница включительно: «действует до» значит до этого момента, а не по этот момент.
    expect(decideLinkAccess({ status: 'sent', expiresAt: NOW }, NOW))
      .toEqual({ allow: false, reason: 'expired' })
  })

  it('на отозванную отвечает про отзыв, а не про срок', () => {
    // Отозвали намеренно — человеку полезнее знать это, чем думать, что не успел.
    expect(decideLinkAccess({ status: 'revoked', expiresAt: YESTERDAY }, NOW))
      .toEqual({ allow: false, reason: 'revoked' })
  })

  it('на уже заполненную отвечает про заполнение, а не про срок', () => {
    expect(decideLinkAccess({ status: 'completed', expiresAt: YESTERDAY }, NOW))
      .toEqual({ allow: false, reason: 'completed' })
  })

  it('не пускает по несуществующей ссылке', () => {
    expect(decideLinkAccess(null, NOW)).toEqual({ allow: false, reason: 'unknown' })
  })
})

describe('переход при открытии', () => {
  it('отправленная становится открытой', () => {
    expect(statusAfterOpen('sent')).toBe('opened')
  })

  it('повторное открытие ничего не меняет', () => {
    // Иначе «открыта» в отчёте превратится в счётчик перезагрузок страницы.
    expect(statusAfterOpen('opened')).toBe('opened')
  })

  it.each<[LinkStatus]>([['created'], ['completed'], ['revoked'], ['expired']])(
    'не воскрешает статус %s',
    (status) => {
      expect(statusAfterOpen(status)).toBe(status)
    },
  )
})

describe('что читает посетитель', () => {
  it('объясняет каждую причину отказа', () => {
    // Гвард на полноту: новая причина без текста показала бы человеку пустую страницу.
    const reasons: LinkDenial[] = ['unknown', 'expired', 'completed', 'revoked', 'not-sent']

    for (const reason of reasons) {
      expect(DENIAL_MESSAGES[reason].title.length).toBeGreaterThan(0)
      expect(DENIAL_MESSAGES[reason].detail.length).toBeGreaterThan(0)
    }
  })

  it('не проговаривается о портале, сделке и клиенте', () => {
    // Страницу видит посторонний человек. Любое слово отсюда — это то, что узнает
    // случайный перебиратель ссылок.
    const everything = Object.values(DENIAL_MESSAGES).map(m => `${m.title} ${m.detail}`).join(' ').toLowerCase()

    for (const leak of ['портал', 'сделк', 'crm', 'битрикс', 'токен', 'элемент']) {
      expect(everything).not.toContain(leak)
    }
  })
})
