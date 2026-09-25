import { afterEach, describe, expect, it, vi } from 'vitest'
import { provisionWithCall } from '../../server/b24/register'
import { logger } from '../../server/utils/logger'

/**
 * Оркестрация обустройства: исход → что мы решили (issue #13).
 *
 * ⚠ Что здесь дорого. `provisionWithCall` — это гейт прав администратора, чтение
 * сохранённых идентификаторов, создание смарт-процессов, запись настроек и разбор отказа
 * на четыре исхода. Инверсия гейта, потерянная ветка `not-admin`, проглоченное исключение —
 * ничего из этого не краснело: `portal-install.test.ts` проверяет только чистую
 * `decideInstall`, до обустройства дело не доходит.
 *
 * ⚠ Мока `getDb()` здесь НЕТ, и это не упущение, а способ. Issue #13 предупреждал, что
 * напрашивается именно он — новая тестовая инфраструктура ради одного места. Оказалось
 * дешевле: `provisionWithCall` уже принимает `RestCall` параметром, и подделать надо ровно
 * портал, как в `provision.test.ts`. База на этом пути не участвует вовсе.
 */

/** Подделка портала: отвечает по имени метода, помнит порядок вызовов. */
function portal(answers: Record<string, unknown | (() => unknown)> = {}) {
  const calls: string[] = []
  const call = vi.fn(async (method: string, _params: Record<string, unknown> = {}) => {
    calls.push(method)
    const answer = answers[method]
    if (typeof answer === 'function') return (answer as () => unknown)()
    if (answer !== undefined) return answer

    // Умолчания счастливого пути: администратор, смарт-процессы уже есть, поля на месте.
    if (method === 'user.admin') return { result: true }
    if (method === 'app.option.get') {
      return { result: JSON.stringify({ template: { entityTypeId: 1038, id: 8 }, survey: { entityTypeId: 1040, id: 10 } }) }
    }
    if (method === 'crm.type.get') {
      return { result: { type: { id: 10, entityTypeId: 1040, title: 'Опрос', relations: { parent: [{ entityTypeId: 2, isChildrenListEnabled: 'Y' }], child: [] } } } }
    }
    if (method === 'crm.type.list') return { result: { types: [] } }
    if (method === 'userfieldconfig.list') return { result: [] }
    return { result: true }
  })
  return { call, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('вкладки приложения', () => {
  it('ГЛАВНОЕ: конструктор вешается на «Шаблон опроса» по entityTypeId', async () => {
    // ⚠ У смарт-процесса ДВА числа, и они разные: у «Шаблона опроса» `entityTypeId = 1038`,
    // `id = 8`. Код точки встраивания собирается из ПЕРВОГО, а имена пользовательских полей —
    // из ВТОРОГО, и оба механизма живут в одном обустройстве. Плюс рядом есть второй
    // смарт-процесс, «Опрос» (1040/10), на который вкладку вешать нельзя вовсе: конструктор
    // правит анкету, а не ответ клиента.
    //
    // Цена ошибки — тихая: портал ответит `ERROR_PLACEMENT_NOT_FOUND`, отказ регистрации
    // установку не роняет, и снаружи это выглядит как успешная установка без вкладки.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal()

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    const bound = p.call.mock.calls
      .filter(([method]) => method === 'placement.bind')
      .map(([, params]) => (params as Record<string, unknown>).PLACEMENT)

    expect(bound).toContain('CRM_DYNAMIC_1038_DETAIL_TAB')
    expect(bound).not.toContain('CRM_DYNAMIC_1040_DETAIL_TAB')
    expect(bound).not.toContain('CRM_DYNAMIC_8_DETAIL_TAB')
  })

  it('вкладка сделки остаётся на месте', async () => {
    // Вторая вкладка не должна вытеснить первую: точки разные, регистрации независимы.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal()

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    const bound = p.call.mock.calls
      .filter(([method]) => method === 'placement.bind')
      .map(([, params]) => (params as Record<string, unknown>).PLACEMENT)

    expect(bound).toContain('CRM_DEAL_DETAIL_TAB')
  })
})

describe('исход обустройства', () => {
  it('ГЛАВНОЕ: без прав администратора — `not-admin`, и портал не трогаем', async () => {
    // ⚠ Права проверяются ПЕРВЫМИ и при установке, а не когда метод понадобится: без них
    // не создать ни смарт-процесс, ни поле, ни записать настройки. Инверсия этого гейта
    // не краснела бы нигде — а стоила бы половины установки, сделанной наполовину.
    const p = portal({ 'user.admin': { result: false } })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('not-admin')
    expect(p.calls).toEqual(['user.admin'])
  })

  it('на счастливом пути — `ok`', async () => {
    const p = portal()

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')
  })

  it('нехватка прав ПРИЛОЖЕНИЯ — отдельный исход, а не общая неудача', async () => {
    // ⚠ Лечится она галочкой в партнёрском кабинете, а не повтором через минуту.
    // Перепутать эти два совета дорого: администратор будет жать «попробовать ещё раз»
    // ровно столько раз, сколько у него терпения.
    const p = portal({
      'userfieldconfig.list': () => {
        throw new Error('insufficient_scope: недостаточно прав приложения')
      },
    })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('no-scope')
  })

  it('всё остальное — `failed`, и исключение наружу не выпускается', async () => {
    // ⚠ Проглоченное исключение здесь означало бы упавшую установку вместо портала
    // в состоянии `degraded`: токены сохранены, а событие установки второй раз не придёт.
    const p = portal({
      'userfieldconfig.list': () => {
        throw new Error('ECONNRESET')
      },
    })

    await expect(provisionWithCall(p.call, 'shef.bitrix24.ru')).resolves.toBe('failed')
  })
})

describe('что уходит в журнал', () => {
  it('ненастроенная связь со сделкой — ОШИБКОЙ, а не заметкой', async () => {
    // ⚠ Приложение установилось, но главного не делает: элемент «Опрос» не привяжется
    // к сделке, и итог не вернётся в карточку. Месяц этот исход был вообще невидимым.
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    // Связь есть у типа, но не та: портал отдаёт `relations` без сделки.
    const p = portal({
      'crm.type.get': { result: { type: { id: 10, entityTypeId: 1040, title: 'Опрос', relations: { parent: [], child: [] } } } },
      'crm.type.update': { result: { type: { id: 10 } } },
    })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    const said = error.mock.calls.some(([, message]) => String(message).includes('НЕ попадёт в карточку сделки'))
    expect(said).toBe(true)
  })

  it('отказ обустройства называет домен, но не токены', async () => {
    // ⚠ Инвариант проекта: в журнал не попадают токены. Домен — не секрет и нужен,
    // чтобы понять, у какого клиента беда.
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const p = portal({
      'userfieldconfig.list': () => {
        throw new Error('ECONNRESET')
      },
    })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    const записи = JSON.stringify(error.mock.calls)
    expect(записи).toContain('shef.bitrix24.ru')
    expect(записи).not.toContain('токен')
  })
})
