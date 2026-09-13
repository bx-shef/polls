import { describe, expect, it } from 'vitest'
import { parseBracketForm } from '../../server/b24/event-body'

/**
 * Тело события приходит формой со скобочными ключами — это прямо сказано в документации
 * («content-type: application/x-www-form-urlencoded», JSON в примерах только показывает
 * структуру). Разбираем сырое тело сами, а не полагаемся на HTTP-слой.
 */

describe('разбор скобочной формы', () => {
  it('собирает тело события установки в дерево', () => {
    const nested = parseBracketForm(
      'event=ONAPPINSTALL&auth[domain]=shef.bitrix24.ru&auth[member_id]=abc&data[VERSION]=1',
    )

    expect(nested).toEqual({
      event: 'ONAPPINSTALL',
      auth: { domain: 'shef.bitrix24.ru', member_id: 'abc' },
      data: { VERSION: '1' },
    })
  })

  it('раскодирует значения', () => {
    expect(parseBracketForm('auth[domain]=shef.bitrix24.ru&auth[scope]=crm%20im'))
      .toEqual({ auth: { domain: 'shef.bitrix24.ru', scope: 'crm im' } })
  })

  it.each([
    ['auth[__proto__][polluted]=yes', '__proto__'],
    ['auth[constructor][prototype][polluted]=yes', 'constructor'],
    ['auth[prototype][polluted]=yes', 'prototype'],
  ])('не даёт загрязнить прототип через %s', (body) => {
    // Все три ключа — рабочие векторы; закрыт должен быть каждый, а не только первый.
    const nested = parseBracketForm(body)

    expect(JSON.stringify(nested)).not.toContain('polluted')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('переживает вложенность произвольной глубины', () => {
    expect(parseBracketForm('a[b][c][d][e]=x')).toEqual({ a: { b: { c: { d: { e: 'x' } } } } })
  })

  it('не падает на пустом и мусорном теле', () => {
    expect(parseBracketForm('')).toEqual({})
    expect(parseBracketForm('просто строка')).toEqual({ 'просто строка': '' })
  })
})
