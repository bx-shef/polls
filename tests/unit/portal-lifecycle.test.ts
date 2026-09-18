import { describe, expect, it } from 'vitest'
import { UNKNOWN_REFUSAL, safeRefusal } from '../../server/domain/answers/portal-errors'
import { PURGE_GRACE_DAYS, isDeadGrant, purgeBoundary } from '../../server/domain/portals/lifecycle'
import { PortalError } from '../../server/domain/portals/portal-error'

/**
 * Гвард под единственный способ узнать, что клиент удалил приложение.
 *
 * ⚠ Предыдущая редакция этого файла была построена на ошибке вида
 * `new Error('КОД: описание')` — форме, которой SDK НЕ ПРОИЗВОДИТ. Из-за неё тесты были
 * зелёными, а механизм в бою не мог сработать ни разу: `SdkError.formatErrorMessage`
 * возвращает ровно `description`, машинный код лежит отдельно в поле `code`, и поиск кода
 * в тексте не находил ничего. Нашла панель ревью PR #34.
 *
 * Поэтому здесь ошибки строятся `PortalError`-ом с РАЗДЕЛЁННЫМИ кодом и описанием — так,
 * как их собирает `server/b24/client.ts` из настоящего ответа SDK. Описания взяты
 * из документации Битрикс24, а не придуманы.
 */

/** Как отказ приезжает из `makePortalCall`: код отдельно, человеческая фраза отдельно. */
const refusal = (code: string, description: string) => new PortalError(code, description)

const NOW = new Date('2026-09-18T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

describe('распознавание мёртвого гранта', () => {
  it('узнаёт отказы сервера авторизации, после которых грант мёртв', () => {
    // Описания — дословно из документации «Коды ошибок сервера авторизации».
    expect(isDeadGrant(refusal('invalid_grant', 'Переданы некорректные авторизационные данные'))).toBe(true)
    expect(isDeadGrant(refusal('invalid_client', 'Переданы некорректные данные клиента'))).toBe(true)
  })

  it('НЕ считает мёртвым неоплаченный период', () => {
    // ⚠ Клиент никуда не делся — он не продлил оплату. Стереть ему токены значит наказать
    // за просрочку платежа потерей установки.
    expect(isDeadGrant(refusal('PAYMENT_REQUIRED', 'Payment required'))).toBe(false)
  })

  it('НЕ считает мёртвым то, что вызвано нашей собственной ошибкой', () => {
    // ⚠ Общее правило списка: сюда попадает только то, что НЕ МОЖЕТ быть вызвано нами.
    // Иначе одна опечатка в конфигурации помечает весь флот, и через месяц уборщик
    // стирает всех клиентов сразу.
    expect(isDeadGrant(refusal('invalid_request', 'Передан некорректно сформированный запрос'))).toBe(false)
    expect(isDeadGrant(refusal('insufficient_scope', 'Запрошены права свыше указанных'))).toBe(false)
    expect(isDeadGrant(refusal('NO_AUTH_FOUND', 'Wrong authorization data'))).toBe(false)
    expect(isDeadGrant(refusal('INVALID_CREDENTIALS', 'Invalid request credentials'))).toBe(false)
  })

  it('НЕ считает мёртвым истёкший access-токен', () => {
    // SDK продлевает его сам. Дойдя до нас, код означает, что продление БЫЛО, то есть
    // грант жив. В первой редакции он стоял в списке мёртвых.
    expect(isDeadGrant(refusal('expired_token', 'The access token provided has expired'))).toBe(false)
  })

  it('НЕ считает мёртвым закрытую публичную часть коробки', () => {
    // `PORTAL_DELETED` по документации про «временное закрытие публичной части сайта»,
    // а не про удаление приложения. Портал на обслуживании дольше срока потерял бы токены.
    expect(isDeadGrant(refusal('PORTAL_DELETED', 'Portal was deleted'))).toBe(false)
  })

  it('не срабатывает на ошибку без структурного кода', () => {
    // Сеть, таймаут, исключение из нашего же кода — это не отказ портала, и назвать его
    // чужим кодом нельзя.
    expect(isDeadGrant(new Error('портал не ответил за 20 000 мс'))).toBe(false)
    expect(isDeadGrant(new Error('invalid_grant'))).toBe(false)
    expect(isDeadGrant(null)).toBe(false)
  })

  it('не срабатывает на текст, набранный респондентом', () => {
    // ⚠ Самый важный тест файла, и теперь он проверяет то, что заявляет. Битрикс24 цитирует
    // присланное значение в ошибке валидации, а присланное значение у нас — ответ клиента.
    // Респондент, набравший в анкете `invalid_grant`, не должен объявлять грант чужого
    // портала мёртвым: решение принимается по полю `error`, в которое он не дотягивается.
    const quoted = refusal(
      'CRM_FIELD_ERROR_VALUE_NOT_VALID',
      'Значение «invalid_grant invalid_client» недопустимо для поля',
    )

    expect(isDeadGrant(quoted)).toBe(false)
    expect(safeRefusal(quoted)).toBe('CRM_FIELD_ERROR_VALUE_NOT_VALID')
  })
})

describe('безопасный текст отказа', () => {
  it('берёт код из структурного поля, а не из описания', () => {
    // ⚠ Описания портала кода в себе НЕ содержат — это и делало прежний поиск подстрокой
    // бесполезным: почти любой настоящий отказ схлопывался в «код не распознан».
    expect(safeRefusal(refusal('ACCESS_DENIED', 'Доступ запрещен'))).toBe('ACCESS_DENIED')
    expect(safeRefusal(refusal('QUERY_LIMIT_EXCEEDED', 'Too many requests'))).toBe('QUERY_LIMIT_EXCEEDED')
  })

  it('незнакомый код наружу не выносит', () => {
    // Список кодов — выбор из нашего набора, а не фильтр чужой строки.
    expect(safeRefusal(refusal('СОВЕРШЕННО_НОВЫЙ_КОД', 'что-то новое'))).toBe(UNKNOWN_REFUSAL)
  })

  it('узнаёт наш собственный таймаут', () => {
    expect(safeRefusal(new Error('портал не ответил за 20 000 мс на crm.item.add'))).toBe('портал не ответил вовремя')
  })

  it('не пропускает наружу текст, набранный респондентом', () => {
    // Ответ клиента в описании — и наружу всё равно уходит только наша константа.
    const leaky = refusal('НЕИЗВЕСТНЫЙ', 'значение «меня зовут Иван, телефон +375...» недопустимо')

    expect(safeRefusal(leaky)).toBe(UNKNOWN_REFUSAL)
    expect(safeRefusal(new Error('значение «меня зовут Иван» недопустимо'))).toBe(UNKNOWN_REFUSAL)
  })
})

describe('отсрочка перед стиранием', () => {
  it('месяц, а не две недели', () => {
    // ⚠ Рабочее значение соседа, а не его нижний порог. Первая редакция брала 14 —
    // это пол, ниже которого сосед запрещает настраивать, а не то, с чем он живёт.
    expect(PURGE_GRACE_DAYS).toBe(30)
  })

  it('граница отстоит от «сейчас» ровно на срок отсрочки', () => {
    const boundary = purgeBoundary(NOW)

    expect(boundary.toISOString()).toBe(days(PURGE_GRACE_DAYS).toISOString())
  })

  it('переживает любой нерабочий период', () => {
    // Смысл срока: портал, молчавший по чужой причине, не должен потерять токены.
    expect(purgeBoundary(NOW).getTime()).toBeLessThan(days(20).getTime())
  })
})
