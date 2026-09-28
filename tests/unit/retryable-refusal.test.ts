import { describe, expect, it } from 'vitest'
import { isRetryableRefusal, PortalError } from '../../server/domain/portals/portal-error'

/**
 * Какой отказ портала стоит повторять.
 *
 * ⚠ На этом решении держится, вернётся ли донастройка к порталу через час. Держать работу
 * незавершённой на отказе, который повтор не вылечит, значит ходить к порталу каждый час вечно;
 * отпустить на отказе, который вылечил бы, — навсегда потерять шаг. Нашёл `/review` во втором
 * круге панели PR #87.
 */
describe('отказ, который лечится повтором', () => {
  it.each(['QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'OVERLOAD_LIMIT', 'INTERNAL_SERVER_ERROR', 'ERROR_UNEXPECTED_ANSWER'])('%s — повторять', (code) => {
    expect(isRetryableRefusal(new PortalError(code, 'описание портала'))).toBe(true)
  })

  it('без кода портала — сеть, таймаут, наше исключение — повторять', () => {
    expect(isRetryableRefusal(new Error('ECONNRESET'))).toBe(true)
    expect(isRetryableRefusal('портал не ответил за 20 с')).toBe(true)
  })

  it.each(['UPDATE_DYNAMIC_TYPE_RESTRICTED', 'ACCESS_DENIED', 'INVALID_ARG_VALUE', 'insufficient_scope'])('%s — не повторять: повтор не вылечит', (code) => {
    expect(isRetryableRefusal(new PortalError(code, 'описание портала'))).toBe(false)
  })

  it('код берётся только из `PortalError`, а не из чего угодно с полем `code`', () => {
    // Иначе системная ошибка Node или чужой объект выбирали бы решение за нас.
    expect(isRetryableRefusal({ code: 'ACCESS_DENIED' })).toBe(true)
  })
})
