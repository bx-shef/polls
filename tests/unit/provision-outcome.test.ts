import { afterEach, describe, expect, it, vi } from 'vitest'
import { provisionWithCall } from '../../server/b24/register'
import { PortalError, UNREACHABLE_CODE } from '../../server/domain/portals/portal-error'
import { PROVISION_REVISION } from '../../server/domain/portals/smart-processes'
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
function portal(answers: Record<string, unknown | ((params: Record<string, unknown>) => unknown)> = {}) {
  const calls: string[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push(method)
    const answer = answers[method]
    if (typeof answer === 'function') return (answer as (p: Record<string, unknown>) => unknown)(params)
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
    // Живой портал отвечает на правку поля самим полем (замерено 28.09): миграция ревизии 4
    // верит закрытию только по этому ответу.
    if (method === 'userfieldconfig.update') return { result: { field: { id: params.id, ...(params.field as object) } } }
    // Своей раскладки у карточки нет — так её отдаёт живой портал (замерено 28.09).
    if (method === 'crm.item.details.configuration.get') return { result: null }
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

  it('ГЛАВНОЕ: обе вкладки получают метку и по-русски, и по-английски', async () => {
    // Гвард на вызывающем, а не на построителе — под находку тестировщика, техдиректора
    // и `/code-review` в PR #87: английские названия в бою оставались непомеченными
    // «Surveys» и «Builder», а тест стоял на построителе, которого бой не вызывал.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal()

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    const titles = p.call.mock.calls
      .filter(([method]) => method === 'placement.bind')
      .map(([, params]) => (params as { LANG_ALL: unknown }).LANG_ALL)

    expect(titles).toEqual([
      { ru: { TITLE: '[sh] Ссылки на опросы' }, en: { TITLE: '[sh] Survey links' } },
      { ru: { TITLE: '[sh] Конструктор' }, en: { TITLE: '[sh] Builder' } },
    ])
  })
})

describe('цена холодной установки', () => {
  it('холодная установка: ровно 57 вызовов портала, миграции 4 и 5 — ни одного лишнего', async () => {
    // ⚠ Число держится намеренно, целой последовательностью. Установка — синхронный путь под
    // общим пределом 45 секунд (`PROVISION_BUDGET_MS`), и каждый новый шаг на нём должен быть
    // виден в ревью, а не проявиться таймаутом у клиента. Комментарии проекта называли холодную
    // установку «17–19 вызовов» — это цена донастройки готового портала, а холодная давно втрое
    // дороже: числа не держал ни один тест. Поднял программист в панели PR #87, что ссылки
    // на гвард нет — `/code-review` во втором круге.
    //
    // Ревизия 5 (штатные стадии) добавила по семь вызовов на смарт-процесс — воронка, стадии, три
    // переименования и два удаления — и сняла по полю «Состояние»: 41 − 2 + 14 = 53. Переноса
    // старого поля на свежей установке нет вовсе: элементов ещё нет, и поля — тоже.
    //
    // Ревизия 7 (поле «Анкета», #84, п. 18) — ещё четыре: регистрация второго типа, его поле
    // и чтение с записью раскладки «Шаблона». `app.info` и список типов — общие на оба поля: 57.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'app.option.get': { result: '' },
      'crm.type.add': (params: Record<string, unknown>) => {
        const title = (params.fields as { title: string }).title
        return { result: { type: title.includes('Шаблон') ? { id: 8, entityTypeId: 1038 } : { id: 10, entityTypeId: 1040 } } }
      },
      'crm.category.list': (params: Record<string, unknown>) => ({ result: { categories: [{ id: params.entityTypeId === 1038 ? 14 : 16, isDefault: 'Y' }] } }),
      'crm.status.list': (params: Record<string, unknown>) => {
        const entity = String((params.filter as { ENTITY_ID: string }).ENTITY_ID)
        const [, e, , c] = entity.split('_')
        const fresh = [['NEW', 'Начало'], ['PREPARATION', 'Подготовка'], ['CLIENT', 'Согласование'], ['SUCCESS', 'Успех'], ['FAIL', 'Провал']]
        return { result: fresh.map(([code, name], index) => ({ ID: String(300 + index), STATUS_ID: `DT${e}_${c}:${code}`, NAME: name })) }
      },
      'userfieldconfig.list': { result: { fields: [] } },
      'app.info': { result: { ID: 219, INSTALLED: true } },
      'crm.type.get': { result: { type: { relations: { parent: [], child: [] } } } },
    })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')

    const funnel = ['crm.category.list', 'crm.status.list', ...Array(3).fill('crm.status.update'), ...Array(2).fill('crm.status.delete')]
    expect(p.calls).toEqual([
      'user.admin', 'app.option.get', 'crm.type.list', 'crm.type.add', 'crm.type.add',
      ...funnel, ...funnel,
      'userfieldconfig.list', ...Array(4).fill('userfieldconfig.add'),
      'userfieldconfig.list', ...Array(8).fill('userfieldconfig.add'),
      'crm.type.get', 'crm.type.update',
      'app.info', 'userfieldtype.list', 'userfieldtype.add', 'userfieldconfig.add', 'userfieldtype.add', 'userfieldconfig.add',
      'crm.item.details.configuration.get', 'crm.item.details.configuration.set',
      'crm.item.details.configuration.get', 'crm.item.details.configuration.set',
      'crm.deal.userfield.list', 'crm.deal.userfield.add', 'crm.deal.userfield.add',
      'crm.contact.userfield.list', 'crm.contact.userfield.add', 'crm.contact.userfield.add',
      'app.option.set', 'placement.unbind', 'placement.bind', 'placement.unbind', 'placement.bind', 'app.option.set',
    ])
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

  it('исход карточки — в итоговой строке журнала, рядом с доменом', async () => {
    // Строки самой раскладки несут только номер типа, а он портала не называет: непонятную или чужую
    // раскладку к порталу привязывает только эта строка. Нашёл `/code-review` в третьем круге
    // панели PR #98.
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const p = portal({ 'crm.item.details.configuration.get': { result: { 0: 'не список' } } })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')

    const line = info.mock.calls.find(([, message]) => message === 'смарт-процессы обустроены')
    expect(line?.[0]).toMatchObject({ domain: 'shef.bitrix24.ru', card: 'unreadable' })
  })

  it('на счастливом пути — `ok`', async () => {
    const p = portal()

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')
  })

  it('нехватка прав ПРИЛОЖЕНИЯ — отдельный исход, а не общая неудача', async () => {
    // ⚠ Лечится она галочкой в партнёрском кабинете, а не повтором через минуту.
    // Перепутать эти два совета дорого: администратор будет жать «попробовать ещё раз»
    // ровно столько раз, сколько у него терпения.
    // ⚠ Отказ — в той форме, что даёт `makePortalCall`: код в поле, в тексте описание портала без кода.
    // Прежде здесь стояла `new Error('insufficient_scope: …')` — форма, которой SDK не производит, — и тест
    // был зелёным, пока мастер не узнавал отказ ни разу (`/code-review` во втором круге панели PR #106).
    const p = portal({
      'userfieldconfig.list': () => {
        throw new PortalError('insufficient_scope', 'The request requires higher privileges than provided by the access token')
      },
    })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('no-scope')
  })

  it('всё остальное — `failed`, и исключение наружу не выпускается', async () => {
    // ⚠ Проглоченное исключение здесь означало бы упавшую установку вместо портала
    // в состоянии `degraded`: токены сохранены, а событие установки второй раз не придёт.
    const p = portal({
      'userfieldconfig.list': () => {
        throw new PortalError(UNREACHABLE_CODE, 'socket hang up')
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
        throw new PortalError(UNREACHABLE_CODE, 'socket hang up')
      },
    })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    const записи = JSON.stringify(error.mock.calls)
    expect(записи).toContain('shef.bitrix24.ru')
    expect(записи).not.toContain('токен')
  })
})

/**
 * Отметка ревизии и незавершённая установка.
 *
 * ⚠ Гвард под находку панели ревью PR #80. Мастер установки обустраивает портал ДО
 * `installFinish()`, и поле своего типа в этот момент портал не примет. Отметь мы ревизию
 * всё равно — фоновая донастройка к порталу не вернулась бы никогда, и виджета не было бы
 * ни у одного клиента, поставившего приложение из Маркета.
 */
describe('отметка ревизии', () => {
  /** Записали ли в `app.option` отметку текущей ревизии. */
  function revisionStored(p: ReturnType<typeof portal>): boolean {
    return p.call.mock.calls
      .filter(([method]) => method === 'app.option.set')
      .some(([, params]) => JSON.stringify(params).includes(`\\"revision\\":${PROVISION_REVISION}`))
  }

  it('НЕ ставится, пока установка не завершена', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({ 'app.info': { result: { ID: 219, INSTALLED: false } } })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')
    expect(revisionStored(p)).toBe(false)
  })

  it('ставится, когда установка завершена', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({ 'app.info': { result: { ID: 219, INSTALLED: true } } })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    expect(revisionStored(p)).toBe(true)
  })

  /** Поле «Шаблона», оставшееся открытым с прошлой ревизии. */
  const OPEN_FIELD = { result: { fields: [{ id: 5, fieldName: 'UF_CRM_8_CODE', editInList: 'Y', editFormLabel: { ru: 'Код шаблона' } }] } }

  /** Наши смарт-процессы в списке портала — под прежними названиями. */
  const LEGACY_TYPES = {
    result: {
      types: [
        { id: 8, entityTypeId: 1038, title: 'Шаблон опроса', isClientEnabled: 'N', isAutomationEnabled: 'N' },
        { id: 10, entityTypeId: 1040, title: 'Опрос', isClientEnabled: 'Y', isAutomationEnabled: 'Y' },
      ],
    },
  }

  /** Что лежит в опции после прогона: последняя запись. */
  function storedOption(p: ReturnType<typeof portal>): Record<string, unknown> {
    const writes = p.call.mock.calls.filter(([method]) => method === 'app.option.set')
    const options = (writes.at(-1)![1] as { options: Record<string, string> }).options
    return JSON.parse(Object.values(options)[0]!) as Record<string, unknown>
  }

  it('ГЛАВНОЕ: четвёртая НЕ ставится, пока наши поля не закрылись от правки — и это ошибка в журнале', async () => {
    // Открытые поля позволяют подделать ответ клиента и опубликовать шаблон в обход проверок
    // (issue #84, пункты 12 и 16). Отметь мы ревизию — донастройка не вернулась бы никогда.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const p = portal({
      'app.info': { result: { ID: 219, INSTALLED: true } },
      'userfieldconfig.list': OPEN_FIELD,
      'userfieldconfig.update': () => { throw new PortalError('ACCESS_DENIED', 'Доступ запрещён') },
    })

    expect(await provisionWithCall(p.call, 'shef.bitrix24.ru')).toBe('ok')
    expect(revisionStored(p)).toBe(false)
    // Всё, кроме миграции 4, на месте — портал отмечен ревизией до неё.
    expect(storedOption(p).revision).toBe(3)
    expect(error.mock.calls.some(([, message]) => String(message).includes('не закрыты от правки'))).toBe(true)
  })

  it('портал ревизии 2 с незаконченной миграцией поднимается до ревизии 3, а не стоит на месте', async () => {
    // Гвард под находку `/code-review` во втором круге PR #87: иначе разовая правка раскладки
    // ревизии 3 повторялась бы каждый час, возвращая виджет клиенту, который его убрал.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'app.option.get': { result: JSON.stringify({ template: { entityTypeId: 1038, id: 8 }, survey: { entityTypeId: 1040, id: 10 }, revision: 2 }) },
      'app.info': { result: { ID: 219, INSTALLED: true } },
      'userfieldconfig.list': OPEN_FIELD,
      'userfieldconfig.update': () => { throw new PortalError('ACCESS_DENIED', 'Доступ запрещён') },
    })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    expect(storedOption(p).revision).toBe(3)
  })

  it('ГЛАВНОЕ: незакрывшиеся поля не стирают прежнюю ревизию', async () => {
    // Гвард под находку `/code-review` в PR #87. Запись идентификаторов без ревизии стирала
    // отметку: портал ревизии 3 следующим прогоном читался как ревизия 0, и разовая правка
    // раскладки возвращала виджет в карточку клиента, который его убрал.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'app.option.get': { result: JSON.stringify({ template: { entityTypeId: 1038, id: 8 }, survey: { entityTypeId: 1040, id: 10 }, revision: 3 }) },
      'app.info': { result: { ID: 219, INSTALLED: true } },
      'userfieldconfig.list': OPEN_FIELD,
      'userfieldconfig.update': () => { throw new PortalError('ACCESS_DENIED', 'Доступ запрещён') },
    })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    expect(storedOption(p).revision).toBe(3)
  })

  it('ставится, когда переименование запретил тариф', async () => {
    // Тарифный отказ повтором не лечится: придержи мы ревизию из-за него, донастройка
    // переобустраивала бы портал каждый час вечно.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'app.info': { result: { ID: 219, INSTALLED: true } },
      'userfieldconfig.list': OPEN_FIELD,
      'crm.type.list': LEGACY_TYPES,
      'crm.type.update': () => { throw new PortalError('UPDATE_DYNAMIC_TYPE_RESTRICTED', 'Тариф') },
    })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    expect(revisionStored(p)).toBe(true)
  })

  it('НЕ ставится, когда переименование сорвал случайный отказ', async () => {
    // Гвард под находку `/review` и `/code-review` в PR #87: любой отказ отпускал ревизию,
    // и одно «слишком много запросов» навсегда отменяло переименование обоих смарт-процессов.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'app.info': { result: { ID: 219, INSTALLED: true } },
      'userfieldconfig.list': OPEN_FIELD,
      'crm.type.list': LEGACY_TYPES,
      'crm.type.update': (params: Record<string, unknown>) => {
        if ('title' in (params.fields as object)) throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
        return { result: { type: { id: 10, relations: { parent: [{ entityTypeId: 2, isChildrenListEnabled: 'Y' }], child: [] } } } }
      },
    })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    expect(revisionStored(p)).toBe(false)
  })

  it('ГЛАВНОЕ: усыновлённый по названию не переименовывается и следующим прогоном', async () => {
    // Гвард под находку `/code-review` во втором круге PR #87, воспроизведённую двумя прогонами.
    // Мастер установки обустраивает портал до `installFinish`: поле виджета откладывается, ревизия
    // не отмечается, и через час приходит донастройка. Без признака усыновления в опции она
    // считала чужой «Шаблон опроса» клиента своим — и выключала ему роботов.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    let option = ''
    const shared = (installed: boolean) => ({
      'app.option.get': () => ({ result: option }),
      'app.option.set': (params: Record<string, unknown>) => {
        option = Object.values(params.options as Record<string, string>)[0]!
        return { result: true }
      },
      'app.info': { result: { ID: 219, INSTALLED: installed } },
      'crm.type.list': { result: { types: [{ id: 8, entityTypeId: 1038, title: 'Шаблон опроса', isClientEnabled: 'Y', isAutomationEnabled: 'Y' }] } },
      'crm.type.add': { result: { type: { id: 10, entityTypeId: 1040 } } },
    })
    const first = portal(shared(false))
    const second = portal(shared(true))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const adoptionWarnings = () => warn.mock.calls.filter(([, message]) => String(message).includes('найден по заголовку')).length

    await provisionWithCall(first.call, 'shef.bitrix24.ru')
    const afterFirst = adoptionWarnings()
    await provisionWithCall(second.call, 'shef.bitrix24.ru')

    const touched = [...first.call.mock.calls, ...second.call.mock.calls]
      .filter(([method, params]) => method === 'crm.type.update' && (params as { id?: number }).id === 8)
    expect(touched).toEqual([])
    expect(JSON.parse(option).adopted).toEqual({ template: true })
    // О находке по заголовку — один раз, когда она случилась, а не на каждой донастройке
    // (`/review`, второй круг): иначе дежурный принимал бы её за новую потерю идентификаторов.
    expect(afterFirst).toBe(1)
    expect(adoptionWarnings()).toBe(1)
  })

  it('ставится на портале, которому миграция уже не нужна', async () => {
    // Гвард из мутационного прогона панели PR #87: во всех тестах этого блока ревизия
    // в опции отсутствовала, и путь «миграции нет вовсе» не проверялся ни разу.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const p = portal({
      'app.option.get': { result: JSON.stringify({
        template: { entityTypeId: 1038, id: 8, categoryId: 14 },
        survey: { entityTypeId: 1040, id: 10, categoryId: 16 },
        revision: PROVISION_REVISION,
      }) },
      'app.info': { result: { ID: 219, INSTALLED: true } },
    })

    await provisionWithCall(p.call, 'shef.bitrix24.ru')

    // Отметка — отдельной записью ПОСЛЕ вкладок. Идентификаторы пишутся до них и прежнюю
    // ревизию сохраняют сами, так что по одному значению в опции путь без отметки не отличить.
    expect(p.calls.lastIndexOf('app.option.set')).toBeGreaterThan(p.calls.lastIndexOf('placement.bind'))
    expect(storedOption(p).revision).toBe(PROVISION_REVISION)
    // Миграции стадий тоже нет: ни воронки, ни стадий, ни листания элементов.
    expect(p.calls.filter(method => /^crm\.(category|status)\.|^crm\.item\.(list|update)$|^userfieldconfig\.delete$/.test(method))).toEqual([])
    // И воронки из опции переживают прогон: без них портал откатился бы на старое поле.
    expect(storedOption(p).survey).toEqual({ entityTypeId: 1040, id: 10, categoryId: 16 })
  })
})
