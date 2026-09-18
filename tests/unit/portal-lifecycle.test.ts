import { describe, expect, it } from 'vitest'
import { safeRefusal } from '../../server/domain/answers/portal-errors'
import { PURGE_GRACE_DAYS, isDeadGrant, purgeBoundary, shouldPurge } from '../../server/domain/portals/lifecycle'

/**
 * Гвард под единственный способ узнать, что клиент удалил приложение.
 *
 * Событие `ONAPPUNINSTALL` нам недоступно: `application_token` приходит только в событиях,
 * а `ONAPPINSTALL` у тиражного приложения с пунктом в меню не приходит вовсе — проверено
 * на живом портале. Значит уход клиента виден только по отказам портала на наши вызовы,
 * и цена ошибки здесь несимметрична в обе стороны:
 *
 * - не заметили — токены ушедшего клиента лежат у нас вечно;
 * - заметили ложно — стёрли токены живого, и он переустанавливает приложение.
 *
 * Вторую сторону закрывает отсрочка, первую — распознавание. Проверяем обе.
 */

const NOW = new Date('2026-09-18T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

describe('распознавание мёртвого гранта', () => {
  it('узнаёт отказы, после которых грант мёртв', () => {
    expect(isDeadGrant('PORTAL_DELETED')).toBe(true)
    expect(isDeadGrant('expired_token')).toBe(true)
    expect(isDeadGrant('NO_AUTH_FOUND')).toBe(true)
  })

  it('не считает мёртвым то, что лечится само или не про портал', () => {
    // ⚠ Каждый из них — живой портал, и пометить его значит начать отсчёт до стирания
    // токенов клиента, который никуда не делся.
    expect(isDeadGrant('QUERY_LIMIT_EXCEEDED')).toBe(false)
    expect(isDeadGrant('OPERATION_TIME_LIMIT')).toBe(false)
    expect(isDeadGrant('OVERLOAD_LIMIT')).toBe(false)
    expect(isDeadGrant('INTERNAL_SERVER_ERROR')).toBe(false)
    expect(isDeadGrant('ACCESS_DENIED')).toBe(false)
    expect(isDeadGrant('insufficient_scope')).toBe(false)
    expect(isDeadGrant('портал не ответил вовремя')).toBe(false)
    expect(isDeadGrant('портал отказал, код не распознан')).toBe(false)
  })

  it('НЕ считает мёртвым INVALID_CREDENTIALS', () => {
    // ⚠ Он может означать нашу пару `client_id`/`client_secret`, а не портал. Опечатка
    // в ней пометила бы мёртвыми ВСЕ порталы разом — и через две недели стёрла бы их.
    expect(isDeadGrant('INVALID_CREDENTIALS')).toBe(false)
  })

  it('не срабатывает на текст, набранный респондентом', () => {
    // ⚠ Самый важный тест файла. Битрикс24 цитирует присланное значение в ошибке валидации,
    // а присланное значение у нас — ответ клиента. Респондент, набравший в анкете
    // `expired_token`, не должен объявлять грант своего же портала мёртвым.
    //
    // Держится это тем, что классифицируем результат `safeRefusal`, а не текст ошибки:
    // он выбирает из закрытого списка наших констант. Проверяем связку целиком, а не
    // предикат в вакууме, — иначе тест не поймает подмену источника.
    const quoted = new Error('CRM_FIELD_ERROR_VALUE_NOT_VALID: значение «expired_token» недопустимо')

    expect(safeRefusal(quoted)).toBe('CRM_FIELD_ERROR_VALUE_NOT_VALID')
    expect(isDeadGrant(safeRefusal(quoted))).toBe(false)
  })
})

describe('отсрочка перед стиранием', () => {
  it('непомеченный портал не стирается никогда', () => {
    expect(shouldPurge(null, NOW)).toBe(false)
  })

  it('свежая отметка не стирает', () => {
    expect(shouldPurge(days(1), NOW)).toBe(false)
    expect(shouldPurge(days(PURGE_GRACE_DAYS - 1), NOW)).toBe(false)
  })

  it('отметка ровно на границе оставляет портал в живых ещё на тик', () => {
    // Строгое сравнение: ошибаться надо в сторону «не стёрли».
    expect(shouldPurge(purgeBoundary(NOW), NOW)).toBe(false)
  })

  it('старая отметка стирает', () => {
    expect(shouldPurge(days(PURGE_GRACE_DAYS + 1), NOW)).toBe(true)
  })

  it('отсрочка переживает новогодние каникулы', () => {
    // ⚠ Смысл срока: портал, молчавший неделю по чужой причине, не должен потерять токены.
    // Число выбрано так, чтобы заведомо перекрывать самый длинный нерабочий период.
    expect(PURGE_GRACE_DAYS).toBeGreaterThan(10)
    expect(shouldPurge(days(10), NOW)).toBe(false)
  })
})
