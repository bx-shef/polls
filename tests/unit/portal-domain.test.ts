import { describe, expect, it } from 'vitest'
import { isPortalDomain } from '../../server/domain/portals/zones'

/**
 * Домен приходит в теле запроса, то есть от кого угодно, и на этом этапе ещё ничем
 * не подтверждён. Всё, что он решает, — стоит ли вообще начинать разговор; но ошибка
 * здесь означает, что мы пойдём на чужой хост с чужим гарантом.
 */

describe('домен облачного портала', () => {
  it.each([
    'shef.bitrix24.ru',
    'shef.bitrix24.by',
    'a.bitrix24.com',
    'portal-with-dashes.bitrix24.de',
  ])('принимает %s', (domain) => {
    expect(isPortalDomain(domain)).toBe(true)
  })

  it('принимает двухсегментные зоны', () => {
    // Их легко потерять, собирая список наивным перебором стран.
    expect(isPortalDomain('shef.bitrix24.com.br')).toBe(true)
    expect(isPortalDomain('shef.bitrix24.com.tr')).toBe(true)
  })

  it.each([
    ['bitrix24.ru', 'без метки портала'],
    ['a.b.bitrix24.ru', 'два уровня вложенности — у Битрикс24 таких не бывает'],
    ['shef.bitrix24.ru.attacker.tld', 'наш домен как приставка к чужому'],
    ['shef-bitrix24.ru', 'дефис вместо точки'],
    ['shef.bitrix24.zz', 'несуществующая зона'],
    ['shef.bitrix24.com.zz', 'подделка под двухсегментную зону'],
    ['-shef.bitrix24.ru', 'метка начинается с дефиса'],
    ['shef.bitrix24.ru:8080', 'порт в домене'],
    ['https://shef.bitrix24.ru', 'это адрес, а не домен'],
    ['', 'пусто'],
  ])('отвергает %s (%s)', (domain) => {
    expect(isPortalDomain(domain)).toBe(false)
  })

  it('не падает на не-строке', () => {
    // Значение приходит из JSON внешнего запроса: там бывает что угодно.
    expect(isPortalDomain(undefined)).toBe(false)
    expect(isPortalDomain(null)).toBe(false)
    expect(isPortalDomain({ toString: () => 'shef.bitrix24.ru' })).toBe(false)
  })
})
