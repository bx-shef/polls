import { describe, expect, it } from 'vitest'
import { REQUIRED_SCOPES, looksLikeScopeRefusal } from '../../server/domain/portals/scopes'

/**
 * Гвард под отличение «не хватает прав» от «не получилось».
 *
 * Лечатся они по-разному: галочка в партнёрском кабинете против повтора через минуту.
 * Показать администратору «попробуйте позже» на причину, которая сама не пройдёт, значит
 * отправить его жать кнопку столько раз, сколько у него терпения.
 *
 * ⚠ Тут же зафиксирован урок PR #30. Там стояла проверка ПО СПИСКУ `portal.scope` до первого
 * вызова, и она была бы неверной: на живом портале `scopes` равен `{app}`, при том что
 * установка прошла целиком. То есть предсказать нехватку прав по ответу сервера авторизации
 * нельзя — можно только узнать её от портала. Тесты ниже проверяют узнавание, а не
 * предсказание, и это разница по существу, а не по форме.
 */

describe('нехватка прав приложения', () => {
  it('узнаётся по коду портала', () => {
    expect(looksLikeScopeRefusal('insufficient_scope')).toBe(true)
    // Так код приезжает, когда его пересказывает SDK вместе со своим текстом.
    expect(looksLikeScopeRefusal('Bitrix24 error: insufficient_scope — the request requires higher privileges')).toBe(true)
  })

  it('узнаётся независимо от регистра', () => {
    expect(looksLikeScopeRefusal('INSUFFICIENT_SCOPE')).toBe(true)
  })

  it('не путается с другими отказами портала', () => {
    // ⚠ Каждый из них лечится не галочкой в кабинете, и выдать их за нехватку прав
    // значит отправить администратора править то, что в порядке.
    expect(looksLikeScopeRefusal('ACCESS_DENIED')).toBe(false)
    expect(looksLikeScopeRefusal('expired_token')).toBe(false)
    expect(looksLikeScopeRefusal('QUERY_LIMIT_EXCEEDED')).toBe(false)
    expect(looksLikeScopeRefusal('CREATE_DYNAMIC_TYPE_RESTRICTED')).toBe(false)
    expect(looksLikeScopeRefusal('')).toBe(false)
  })

  it('называет ровно те разрешения, которые отмечают в кабинете', () => {
    // Список записан здесь ВРУЧНУЮ, а не выведен из константы: взятый из неё, он
    // расширялся бы вместе с ней и остался бы зелёным на любом изменении — тест
    // доказывал бы, что константа равна себе. Этот класс дефекта в проекте уже ловили.
    expect([...REQUIRED_SCOPES]).toEqual(['crm', 'userfieldconfig', 'placement'])
  })
})
