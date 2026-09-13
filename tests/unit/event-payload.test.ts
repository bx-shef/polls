import { describe, expect, it } from 'vitest'
import { nestEventBody } from '../../server/b24/event-payload'

/**
 * Документация показывает тело события как JSON, а примеры обработчиков читают
 * `$_REQUEST['auth']` — то есть форму со скобочными ключами. Пока это не проверено
 * на живом портале, обработчик обязан пережить оба вида; тест держит именно это.
 */

describe('сборка тела события', () => {
  it('собирает скобочные ключи формы в дерево', () => {
    const nested = nestEventBody({
      'event': 'ONAPPINSTALL',
      'auth[domain]': 'shef.bitrix24.ru',
      'auth[member_id]': 'abc',
      'data[VERSION]': '1',
    })

    expect(nested).toEqual({
      event: 'ONAPPINSTALL',
      auth: { domain: 'shef.bitrix24.ru', member_id: 'abc' },
      data: { VERSION: '1' },
    })
  })

  it('оставляет как есть тело, уже пришедшее деревом', () => {
    const json = { event: 'ONAPPINSTALL', auth: { domain: 'shef.bitrix24.ru' } }

    expect(nestEventBody(json)).toEqual(json)
  })

  it('не даёт загрязнить прототип', () => {
    // Ключи приходят из внешнего запроса; `auth[__proto__][isAdmin]` — это не теория.
    const nested = nestEventBody({ 'auth[__proto__][polluted]': 'yes' })

    expect(nested).toEqual({})
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('пропускает ключ с несошедшимися скобками, а не склеивает его', () => {
    // Склеенный ключ положил бы значение не туда, куда его адресовали, — молча.
    expect(nestEventBody({ 'auth[domain': 'x', 'event': 'ONAPPINSTALL' }))
      .toEqual({ event: 'ONAPPINSTALL' })
  })

  it('обрезает слишком глубокую вложенность', () => {
    expect(nestEventBody({ 'a[b][c][d][e]': 'x' })).toEqual({})
  })

  it('не падает на не-объекте', () => {
    expect(nestEventBody(null)).toEqual({})
    expect(nestEventBody('строка')).toEqual({})
  })
})
