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

  it('без кода — наше исключение и наш таймаут — повторять', () => {
    // Беда связи сюда больше не относится: у неё свой код (`SHEF_UNREACHABLE`, ниже), issue #99.
    expect(isRetryableRefusal(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isRetryableRefusal(new Error('crm.item.update: портал не ответил за 20000 мс'))).toBe(true)
  })

  it.each(['UPDATE_DYNAMIC_TYPE_RESTRICTED', 'ACCESS_DENIED', 'INVALID_ARG_VALUE', 'insufficient_scope'])('%s — не повторять: повтор не вылечит', (code) => {
    expect(isRetryableRefusal(new PortalError(code, 'описание портала'))).toBe(false)
  })

  it('отказ портала без кода (`SHEF_REJECTED`) — не повторять: повтор не переубедит портал', () => {
    // Так `asPortalError` называет `"error": ""` или `"0"` при 4xx, кроме 408 и 429, и `"0"` при 2xx
    // (issue #99). Пустота здесь значила бы «ответа не было», и портал вечно ходил бы по кругу обустройства.
    expect(isRetryableRefusal(new PortalError('SHEF_REJECTED', 'Section at index 0 does not have title.'))).toBe(false)
  })

  it('ответа портала нет (`SHEF_UNREACHABLE`) — повторять: сеть и прокси лечит время', () => {
    // Свой код, а не пустота, — ради журнала (`safeRefusal` его называет); повторяется так же.
    expect(isRetryableRefusal(new PortalError('SHEF_UNREACHABLE', 'socket hang up'))).toBe(true)
  })

  it('список не дочитан (`SHEF_LIST_TRUNCATED`) — не повторять: сам список не укоротится', () => {
    // На это опирается `refuse` у обустройства: разовый шаг миграции не ходит к порталу каждый час из-за
    // списка, который повтор не дочитает (`/review` в третьем круге PR #113).
    expect(isRetryableRefusal(new PortalError('SHEF_LIST_TRUNCATED', 'crm.type.list: список не дочитан за 100 страниц'))).toBe(false)
  })

  it('код берётся только из `PortalError`, а не из чего угодно с полем `code`', () => {
    // Иначе системная ошибка Node или чужой объект выбирали бы решение за нас.
    expect(isRetryableRefusal({ code: 'ACCESS_DENIED' })).toBe(true)
  })
})
