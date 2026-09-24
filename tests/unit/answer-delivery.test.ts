import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backoffMinutes,
  readAnswers,
  resolveSurveyProcess,
  tryEntityScore,
  tryTimelineActivity,
  writeToPortal,
} from '../../server/answers/deliver'
import { safeRefusal, UNKNOWN_REFUSAL } from '../../server/domain/answers/portal-errors'
import { PortalError } from '../../server/domain/portals/portal-error'
import type { SurveyTemplate } from '../../server/domain/surveys/model'
import { scoreSurvey } from '../../server/domain/surveys/scoring'
import { ACTIVITY_ORIGINATOR_ID, activityOriginId } from '../../server/domain/answers/timeline-activity'
import { logger } from '../../server/utils/logger'

/**
 * Доставка ответа в портал — единственный канал, которым ответ клиента попадает в CRM,
 * и он приехал без единого теста; нашла панель ревью PR #22. Здесь закрыто то, что
 * проверяется без базы и без сети: порядок вызовов, разделение обязательного и удобства,
 * и главное — что отказ портала не выносит наружу текст ответа.
 *
 * Приём тот же, что в `tests/unit/provision.test.ts`: подделка `RestCall`.
 */

const SURVEY = { entityTypeId: 1046, id: 8 }

const TEMPLATE: SurveyTemplate = {
  code: 'brand',
  title: 'Оценка работы',
  sections: [{
    key: 'product',
    title: 'Продукт',
    scored: true,
    bands: [],
    questions: [
      { key: 'P1', sourceKey: 'P1', title: 'Качество', type: 'scale', weight: 100, scored: true, scale: { min: 0, max: 10 } },
      { key: 'T1', sourceKey: 'T1', title: 'Словами', type: 'text', weight: 0, scored: false },
    ],
  }],
}

const ANSWERS = { P1: 9, T1: 'Совершенно секретный текст клиента' }

/** Подделка портала: отвечает по методу, помнит порядок вызовов. */
function portal(answers: Record<string, unknown | ((p: Record<string, unknown>) => unknown)> = {}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    const answer = answers[method]
    if (typeof answer === 'function') return (answer as (p: Record<string, unknown>) => unknown)(params)
    if (answer !== undefined) return answer
    if (method === 'app.option.get') {
      return { result: JSON.stringify({ template: { entityTypeId: 1044, id: 7 }, survey: SURVEY }) }
    }
    if (method === 'crm.item.update') return { result: { item: { id: 777 } } }
    if (method === 'crm.item.get') return { result: { item: { id: 777, parentId2: 351, assignedById: 5 } } }
    // Пусто — дела с нашей меткой ещё нет. Так отвечает портал на первую доставку.
    if (method === 'crm.activity.list') return { result: [] }
    if (method === 'crm.activity.todo.add') return { result: { id: 9001 } }
    return { result: true }
  })
  return { call, calls, methods: () => calls.map(c => c.method), of: (m: string) => calls.filter(c => c.method === m) }
}

describe('запись ответа в портал', () => {
  it('обновляет элемент ДО того, как пробует комментировать', async () => {
    // Порядок и есть смысл: после обновления элемента ответ живёт в источнике истины,
    // и наш буфер перестаёт быть единственным местом, где он есть. Обратный порядок
    // сделал бы неудачу комментария причиной откладывать саму доставку.
    const p = portal()
    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    const methods = p.methods()
    expect(methods.indexOf('crm.item.update')).toBeLessThan(methods.indexOf('crm.activity.todo.add'))
  })

  it('считает доставку удавшейся, даже если комментарий не записался', async () => {
    // Запись в таймлайн — удобство. Ответ уже в элементе смарт-процесса, то есть в источнике
    // истины; проваливать из-за неё доставку значит поставить сам ответ в зависимость
    // от необязательного шага.
    const p = portal({
      'crm.activity.todo.add': () => {
        throw new Error('ACCESS_DENIED')
      },
    })
    const outcome = await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(outcome).toEqual({ ok: true, itemId: 777, reported: false })
  })

  it('просит повторить, когда смарт-процесс на портале не найден', async () => {
    // Установка могла идти прямо сейчас. Сдаваться с первой попытки здесь рано.
    //
    // ⚠ Проверяется на `resolveSurveyProcess`, а не на `writeToPortal`: поиск смарт-процесса
    // выделен из записи, потому что живая проверка `verify:link` ходит вебхуком, а под ним
    // `app.option.get` отвечает `Application context required`. Прежнее второе утверждение
    // («в портал не пошли писать») отсюда ушло вместе с веткой — теперь это не поведение,
    // а устройство: `deliverOne` возвращает этот исход раньше, чем доходит до записи.
    const p = portal({ 'app.option.get': { result: '' } })

    expect(await resolveSurveyProcess(p.call))
      .toEqual({ ok: false, retry: true, reason: 'смарт-процесс «Опрос» не найден на портале' })
  })

  it('находит смарт-процесс, когда он на портале есть', async () => {
    // Обратная сторона: гвард выше не должен быть зелёным просто потому, что функция
    // всегда возвращает отказ.
    expect(await resolveSurveyProcess(portal().call)).toEqual(SURVEY)
  })

  it('не считает доставкой двухсотый ответ без элемента', async () => {
    // Иначе строка буфера удаляется, а в портал не записано ничего.
    const p = portal({ 'crm.item.update': { error: 'ACCESS_DENIED' } })
    const outcome = await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(outcome.ok).toBe(false)
  })

  it('не комментирует, когда элемент отвязан от сделки', async () => {
    const p = portal({ 'crm.item.get': { result: { item: { id: 777 } } } })
    const outcome = await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(outcome).toEqual({ ok: true, itemId: 777, reported: false })
    expect(p.methods()).not.toContain('crm.activity.todo.add')
  })

  it('не отправляет пустой комментарий: портал его отвергает', async () => {
    const empty: SurveyTemplate = { ...TEMPLATE, sections: [{ ...TEMPLATE.sections[0]!, scored: false, questions: [] }] }
    const p = portal()
    // ⚠ Элемент передаётся УЖЕ ПРОЧИТАННЫМ: его читает `writeToPortal` один раз
    // и раздаёт обоим шагам — таймлайну и полям на сделке.
    const item = { result: { item: { id: 777, parentId2: 351 } } }
    await tryTimelineActivity(p.call, SURVEY, 777, empty, {}, scoreSurvey(empty, {}), item)

    expect(p.methods()).not.toContain('crm.activity.todo.add')
  })
})

/**
 * Гвард под дефект «комментарий не появился, и узнать почему нечем».
 *
 * ⚠ Нашёлся первым сквозным прогоном на живом портале, а не тестом, и это показательно:
 * все тесты выше проверяют, что `tryTimelineActivity` ВЕРНЁТ `false` в нужных случаях, — и ни один
 * не спрашивал, скажет ли он об этом. Доставка при этом считается успешной, строка буфера
 * удаляется, в журнале — тишина. Осталось «комментария нет, причин ноль».
 *
 * Поэтому здесь проверяется ровно выход в журнал, и отдельно — что в него НЕ попало.
 */
describe('запись в таймлайн не удалась — это должно быть видно', () => {
  afterEach(() => vi.restoreAllMocks())

  it('отвязанный элемент: в журнал уходят имена полей связи', async () => {
    // Имена нужны, чтобы отличить «связи правда нет» от «связь названа иначе, чем мы ждём».
    // Второе значит, что комментарий не придёт никогда, и по `null` эти случаи неразличимы.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const p = portal({ 'crm.item.get': { result: { item: { id: 777, PARENT_ID_2: 351 } } } })

    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    const said = warn.mock.calls.find(([, message]) => String(message).includes('нет связи со сделкой'))
    expect(said).toBeDefined()
    expect((said![0] as { parentFields: string[] }).parentFields).toEqual(['PARENT_ID_2'])
  })

  it('идентификатор сделки в журнал не уходит', async () => {
    // ⚠ Инвариант проекта: в логи не попадают идентификаторы клиентов портала. Сделка —
    // это конкретный клиент, и в журнале ей места нет ни при отказе, ни при удаче.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const p = portal()

    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    const everything = JSON.stringify([...warn.mock.calls, ...info.mock.calls])
    expect(everything).not.toContain('351')
    expect(everything).not.toContain('Совершенно секретный текст клиента')
  })

  it('удавшийся комментарий тоже оставляет след', async () => {
    // Без него «комментарий записан» и «до комментария не дошло» выглядят одинаково.
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const p = portal()

    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(info.mock.calls.some(([, message]) => String(message).includes('таймлайн'))).toBe(true)
  })
})

/**
 * Гварды под то, ради чего комментарий заменён делом.
 *
 * ⚠ `crm.timeline.comment.add` не идемпотентен: второй вызов добавлял второй комментарий.
 * Это стояло в коде как принятый риск и прямо противоречило инварианту проекта «перед
 * созданием — поиск существующего». У дела есть метка внешнего источника, и здесь
 * проверяется, что мы ею действительно пользуемся, а не просто наносим.
 */
describe('дело пишется один раз', () => {
  afterEach(() => vi.restoreAllMocks())

  it('найдено по метке — второго не создаём', async () => {
    // ⚠ Главный тест файла. Портал, а не наша таблица, — источник правды о том, писали мы уже.
    const p = portal({ 'crm.activity.list': { result: [{ ID: 4242 }] } })

    const outcome = await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(outcome).toEqual({ ok: true, itemId: 777, reported: true })
    expect(p.methods()).not.toContain('crm.activity.todo.add')
  })

  it('ищет ПАРОЙ, а не одним идентификатором', async () => {
    // Один `ORIGIN_ID` мог бы совпасть с делом, которое клиент завёл сам или принёс другой
    // поставщик, — и мы молча решили бы, что уже писали.
    const p = portal()

    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    const filter = p.of('crm.activity.list')[0]!.params.filter as Record<string, string>
    expect(filter.ORIGINATOR_ID).toBe(ACTIVITY_ORIGINATOR_ID)
    expect(filter.ORIGIN_ID).toBe(activityOriginId(777))
  })

  it('метка наносится вторым вызовом — иначе дело не найдётся никогда', async () => {
    // `todo.add` метку не принимает. Не нанеся её, мы получили бы дело, невидимое поиску,
    // и следующая запись создала бы второе.
    const p = portal()

    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    const fields = p.of('crm.activity.update')[0]!.params.fields as Record<string, unknown>
    expect(fields.ORIGIN_ID).toBe(activityOriginId(777))
    // 2 — bbCode по `crm.enum.contenttype` с живого портала (3 там HTML, а не BB).
    expect(fields.DESCRIPTION_TYPE).toBe(2)
  })

  it('непомеченное дело СНИМАЕТСЯ, а не остаётся висеть', async () => {
    // ⚠ Непомеченное дело хуже, чем никакого: поиск его не найдёт, а следующая доставка
    // напишет второе. Компенсация закрывает всё, кроме смерти процесса между двумя вызовами.
    const p = portal({
      'crm.activity.update': () => {
        throw new Error('ACCESS_DENIED')
      },
    })

    const outcome = await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(outcome).toEqual({ ok: true, itemId: 777, reported: false })
    expect(p.of('crm.activity.delete')[0]!.params.id).toBe(9001)
  })

  it('не считает записью ответ без идентификатора', async () => {
    // `null` читался бы как «ничего не записано», метка не наносится, и следующая доставка
    // пишет заново. Приняв мусор за идентификатор, мы нанесли бы метку в пустоту.
    const p = portal({ 'crm.activity.todo.add': { result: { id: 'не число' } } })

    const outcome = await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(outcome).toEqual({ ok: true, itemId: 777, reported: false })
    expect(p.methods()).not.toContain('crm.activity.update')
  })

  it('ответственный — тот, кто выпускал ссылку', async () => {
    const p = portal()

    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(p.of('crm.activity.todo.add')[0]!.params.responsibleId).toBe(5)
  })

  it('текст ответа клиента наружу в журнал не уходит', async () => {
    // Тот же инвариант, что и раньше: ответ едет в портал, но не в наш журнал.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const p = portal()

    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    const said = JSON.stringify([...warn.mock.calls, ...info.mock.calls])
    expect(said).not.toContain('Совершенно секретный текст клиента')
    expect(said).not.toContain('351')
  })
})

describe('отказ портала не выносит наружу ответ клиента', () => {
  it('сводит отказ к коду, даже когда портал процитировал присланное', () => {
    // ⚠ Главный тест файла. Битрикс24 в ошибке валидации цитирует присланное значение —
    // а присланное здесь и есть ответ клиента. SDK такое не вырезает: его собственная
    // документация говорит прямо, что «portal prose» остаётся как есть.
    //
    // ⚠ Ошибка строится `PortalError`-ом с РАЗДЕЛЁННЫМИ кодом и описанием — так, как её
    // собирает `server/b24/client.ts`. Прежняя редакция склеивала их в одну строку
    // `new Error('КОД: описание')`, формы, которой SDK не производит: `formatErrorMessage`
    // возвращает ровно `description`, а код лежит отдельно в поле `code`. Тест был зелёным
    // на выдуманной форме и потому не замечал, что в бою `safeRefusal` не распознаёт
    // почти ничего. Нашла панель ревью PR #34.
    const quoted = new PortalError(
      'CRM_FIELD_ERROR_VALUE_NOT_VALID',
      'значение поля UF_CRM_8_ANSWERS слишком длинное: '
      + '{"P1":9,"T1":"Совершенно секретный текст клиента"}',
    )

    const reason = safeRefusal(quoted)

    expect(reason).toBe('CRM_FIELD_ERROR_VALUE_NOT_VALID')
    expect(reason).not.toContain('секретный')
    expect(reason).not.toContain('T1')
  })

  it('не принимает код, набранный респондентом в описании', () => {
    // ⚠ Гвард под управляемость классификации. Прежний `safeRefusal` искал коды подстрокой
    // по всему тексту и возвращал первый ПО ПОРЯДКУ В МАССИВЕ, а не первый по строке, —
    // то есть респондент мог выбрать код за нас. На этом коде принимаются необратимые
    // решения (`server/domain/portals/lifecycle.ts`). Нашла панель ревью PR #34.
    const steered = new PortalError('НЕИЗВЕСТНЫЙ_КОД', 'значение «expired_token ACCESS_DENIED» недопустимо')

    expect(safeRefusal(steered)).toBe('портал отказал, код не распознан')
  })

  it('на нераспознанный отказ отдаёт СВОЮ строку, а не отфильтрованную чужую', () => {
    // Фильтр рано или поздно пропускает: достаточно набрать ответ заглавными через
    // подчёркивания. Поэтому результат — всегда одна из наших констант.
    expect(safeRefusal(new Error('ЧТО_ТО_НОВОЕ: и дальше текст клиента'))).toBe(UNKNOWN_REFUSAL)
    expect(safeRefusal(new Error('МОЙ_ОТВЕТ_ТАКОЙ'))).toBe(UNKNOWN_REFUSAL)
    expect(safeRefusal(undefined)).toBe(UNKNOWN_REFUSAL)
    expect(safeRefusal(new Error(''))).toBe(UNKNOWN_REFUSAL)
  })

  it('называет таймаут таймаутом', () => {
    expect(safeRefusal(new Error('crm.item.update: портал не ответил за 20000 мс')))
      .toBe('портал не ответил вовремя')
  })
})

describe('разбор тела буфера', () => {
  it('принимает числа, строки и null', () => {
    expect(readAnswers({ answers: { a: 9, t: 'текст', skipped: null } }))
      .toEqual({ a: 9, t: 'текст', skipped: null })
  })

  it('отвергает тело целиком, а не выбрасывает непонятный ключ', () => {
    // Молча выбросить ключ значит записать в портал НЕПОЛНЫЙ ответ под видом полного.
    // Лучше оставить строку человеку.
    expect(readAnswers({ answers: { a: 9, bad: { nested: true } } })).toBeNull()
    expect(readAnswers({ answers: { a: 9, bad: [1, 2] } })).toBeNull()
  })

  it('отвергает то, что не похоже на буфер', () => {
    for (const payload of [null, 'строка', [], {}, { answers: null }, { answers: [] }]) {
      expect(readAnswers(payload)).toBeNull()
    }
  })
})

describe('пауза перед повтором', () => {
  it('растёт вдвое и упирается в час', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMinutes)).toEqual([1, 2, 4, 8, 16, 32, 60, 60])
  })

  it('не уходит в ноль и не становится отрицательной', () => {
    expect(backoffMinutes(0)).toBe(1)
    expect(backoffMinutes(-5)).toBe(1)
  })
})

/**
 * Балл в пользовательские поля сделки и контакта (issue #23).
 *
 * ⚠ Зачем вообще: балл на элементе «Опроса» не виден ни фильтру в списке сделок, ни роботу
 * на стадии — элемент дочерняя сущность. Обещанное клиенту «покажи сделки с оценкой ниже семи»
 * работает только через поле на самой сделке.
 */
describe('балл уезжает в сделку и в контакт', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Элемент «Опроса», каким его отдаёт портал: связь со сделкой и снимок контакта. */
  const ITEM = { result: { item: { id: 777, parentId2: 351, contactId: 12, assignedById: 5 } } }
  const SCORE = scoreSurvey(TEMPLATE, ANSWERS)

  /** Что ушло в `crm.item.update` по каждой сущности. */
  function writes(p: ReturnType<typeof portal>) {
    return p.of('crm.item.update').map(one => one.params as Record<string, unknown>)
  }

  it('пишет и в сделку, и в контакт', async () => {
    const p = portal()
    await tryEntityScore(p.call, ITEM, SCORE)

    expect(writes(p).map(params => params.entityTypeId)).toEqual([2, 3])
    expect(writes(p).map(params => params.id)).toEqual([351, 12])
  })

  it('БЕЗ ОБЩЕГО БАЛЛА не пишет ничего — ноль не то же самое, что молчание', async () => {
    // ⚠ ГЛАВНЫЙ ГВАРД. Тот же инвариант, что у нетронутого ползунка: «нет ответа — это `null`,
    // а не ноль». Ответили только на текстовые вопросы — общего балла нет; записав в поле
    // «оценка клиента» ноль, мы выдали бы за молчание худшую возможную оценку, и фильтр
    // «ниже семи» показал бы менеджеру сделку, по которой никто ничего не оценивал.
    const p = portal()
    await tryEntityScore(p.call, ITEM, { sections: [], overall: null })

    expect(p.methods()).not.toContain('crm.item.update')
  })

  it('без сделки и без контакта говорит об этом в журнал', async () => {
    // Состояние «ответ в портале, а фильтры по нему не работают» ненаблюдаемо по построению.
    // Ровно такой исход у связи со сделкой был невидимым месяц.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const p = portal()

    await tryEntityScore(p.call, { result: { item: { id: 777 } } }, SCORE)

    expect(p.methods()).not.toContain('crm.item.update')
    expect(JSON.stringify(warn.mock.calls)).toContain('ни сделки, ни контакта')
  })

  it('отказ по контакту не мешает сделке', async () => {
    // Сделка важнее: по ней фильтруют. Общий цикл, падающий на первой ошибке, оставил бы
    // без балла обе сущности из-за одной.
    const p = portal({
      'crm.item.update': (params: Record<string, unknown>) => {
        if (params.entityTypeId === 2) return { result: { item: { id: 351 } } }
        throw new Error('ACCESS_DENIED')
      },
    })

    await tryEntityScore(p.call, ITEM, SCORE)

    expect(writes(p)).toHaveLength(2)
  })

  it('в журнал не уходит идентификатор клиента портала', async () => {
    // ⚠ Инвариант проекта: идентификаторы клиентов портала в логи не попадают. Название
    // сущности и код отказа — можно, номер сделки — нет.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const p = portal({
      'crm.item.update': () => {
        throw new Error('ACCESS_DENIED')
      },
    })

    await tryEntityScore(p.call, ITEM, SCORE)

    const written = JSON.stringify(warn.mock.calls)
    expect(written).toContain('сделка')
    expect(written).not.toContain('351')
    expect(written).not.toContain('12')
  })

  it('неудача записи балла НЕ проваливает доставку', async () => {
    // Ответ уже в элементе смарт-процесса, то есть в источнике истины. Проваливать доставку
    // из-за поля на чужой сущности значит поменять местами главное и второстепенное.
    const p = portal({
      'crm.item.update': (params: Record<string, unknown>) => {
        if (params.entityTypeId === 2 || params.entityTypeId === 3) throw new Error('ACCESS_DENIED')
        return { result: { item: { id: 777 } } }
      },
      'crm.item.get': ITEM,
    })

    await expect(writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)).resolves.toMatchObject({ ok: true })
  })

  it('элемент читается ОДИН раз на оба шага', async () => {
    // Раньше его читал только таймлайн. Второй читатель означал бы второй `crm.item.get`
    // на каждый доставленный ответ — при том что данные в нём одни и те же.
    const p = portal({ 'crm.item.get': ITEM })

    await writeToPortal(p.call, SURVEY, 777, TEMPLATE, ANSWERS)

    expect(p.of('crm.item.get')).toHaveLength(1)
  })
})
