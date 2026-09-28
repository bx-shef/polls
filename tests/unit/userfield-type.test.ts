import { describe, expect, it } from 'vitest'
import {
  CARD_RESULT_SECTION,
  SURVEY_RESULT_FIELD,
  buildCardSections,
  buildFieldName,
  planSurveyCard,
} from '../../server/domain/portals/smart-processes'
import {
  SURVEY_RESULT_TYPE,
  buildRegisterTypeCall,
  buildUpdateTypeCall,
  findRegisteredType,
  fullTypeCode,
  isOurFieldType,
  isSurveyCard,
  planTypeRegistration,
  readAppInfo,
} from '../../server/domain/portals/userfield-type'

/**
 * Поле своего типа «Результат опроса»: регистрация, полный код, раскладка карточки.
 *
 * Чистые функции, без портала. Сквозной путь обустройства — в `provision.test.ts`.
 */

const SURVEY = { entityTypeId: 1046, id: 8 }
const HANDLER = 'https://polls.example/uf/survey-result'

describe('регистрация типа', () => {
  it('регистрирует, правит и не трогает — по тому, что уже стоит', () => {
    expect(planTypeRegistration(null, HANDLER)).toBe('add')
    expect(planTypeRegistration({ handler: 'https://old.example/uf/survey-result' }, HANDLER)).toBe('update')
    // ⚠ Совпал адрес — не зовём правку вовсе: у неё есть отказ «Handler already binded»,
    // и выяснять, считает ли портал занятым адрес, которым занят сам тип, незачем.
    expect(planTypeRegistration({ handler: HANDLER }, HANDLER)).toBe('keep')
  })

  it('правка и регистрация несут одно и то же описание, отличается только метод', () => {
    const add = buildRegisterTypeCall(HANDLER)
    const update = buildUpdateTypeCall(HANDLER)

    expect(add.method).toBe('userfieldtype.add')
    expect(update.method).toBe('userfieldtype.update')
    expect(update.params).toEqual(add.params)
    expect(add.params.HANDLER).toBe(HANDLER)
    expect(add.params.USER_TYPE_ID).toBe(SURVEY_RESULT_TYPE)
  })

  it('находит свой тип по короткому коду и читает его адрес', () => {
    // Форма ответа — из документации `userfieldtype.list`: коды без префикса приложения.
    const response = {
      result: [
        { USER_TYPE_ID: 'someone_else', HANDLER: 'https://other.example/x' },
        { USER_TYPE_ID: SURVEY_RESULT_TYPE, HANDLER },
      ],
    }

    expect(findRegisteredType(response)).toEqual({ handler: HANDLER })
  })

  it('сверяет код целиком, а не вхождением', () => {
    // Чужой тип с нашим кодом внутри имени — не наш. Первая редакция искала вхождением.
    const response = { result: [{ USER_TYPE_ID: `${SURVEY_RESULT_TYPE}_v2`, HANDLER }] }

    expect(findRegisteredType(response)).toBeNull()
  })

  it.each<[unknown, string]>([
    [{ result: [] }, 'типов нет'],
    [{ result: true }, 'не список'],
    [null, 'ничего'],
  ])('без своего типа отвечает null (%#: %s)', (response) => {
    expect(findRegisteredType(response)).toBeNull()
  })
})

describe('полный код типа', () => {
  it('собирается из идентификатора приложения, как в официальном гайде', () => {
    // «Для приложения с ID = 123 полный код типа будет rest_123_phone_data».
    expect(fullTypeCode(219)).toBe(`rest_219_${SURVEY_RESULT_TYPE}`)
  })

  it('читает идентификатор приложения из `app.info` — числом и строкой', () => {
    expect(readAppInfo({ result: { ID: 219, INSTALLED: true } }).id).toBe(219)
    expect(readAppInfo({ result: { ID: '219', INSTALLED: true } }).id).toBe(219)
  })

  it.each<[unknown, string]>([
    [{ result: {} }, 'нет ID'],
    [{ result: { ID: 0 } }, 'ноль'],
    [{ result: { ID: 'abc' } }, 'не число'],
    [{ result: { ID: '' } }, 'пустая строка — не ноль'],
    [null, 'ничего'],
  ])('без идентификатора отвечает null (%#: %s)', (response) => {
    expect(readAppInfo(response).id).toBeNull()
  })

  it.each<[unknown, string]>([
    [false, 'как в документации'],
    ['N', 'флагом портала'],
    [0, 'нулём'],
  ])('видит незавершённую установку (%#: %s)', (flag) => {
    // ⚠ До `installFinish` поле своего типа портал не примет — шаг надо отложить.
    expect(readAppInfo({ result: { ID: 219, INSTALLED: flag } }).installed).toBe(false)
  })

  it('без признака считает установку завершённой', () => {
    // Иначе на портале, который признак не шлёт, шаг откладывался бы вечно.
    expect(readAppInfo({ result: { ID: 219 } }).installed).toBe(true)
    expect(readAppInfo({ result: { ID: 219, INSTALLED: true } }).installed).toBe(true)
  })
})

describe('наш ли тип у поля', () => {
  it('узнаёт свой полный код — в любом регистре', () => {
    expect(isOurFieldType(`rest_219_${SURVEY_RESULT_TYPE}`, 219)).toBe(true)
    expect(isOurFieldType(`REST_219_${SURVEY_RESULT_TYPE.toUpperCase()}`, 219)).toBe(true)
  })

  it.each<[unknown, string]>([
    ['string', 'строковое поле клиента на «усыновлённом» смарт-процессе'],
    [`rest_7_${SURVEY_RESULT_TYPE}`, 'наш тип, но от прошлой установки приложения'],
    [undefined, 'портал тип не назвал'],
  ])('чужое не признаёт (%#: %s)', (userTypeId) => {
    expect(isOurFieldType(userTypeId, 219)).toBe(false)
  })
})

describe('чья карточка', () => {
  it('узнаёт карточку «Опроса» по `ENTITY_ID` — в любом регистре', () => {
    expect(isSurveyCard({ entityId: 'CRM_8', entityTypeId: null }, SURVEY)).toBe(true)
    expect(isSurveyCard({ entityId: 'crm_8', entityTypeId: null }, SURVEY)).toBe(true)
  })

  it('узнаёт её и по `ENTITY_DATA.entityTypeId`, когда `ENTITY_ID` не пришёл', () => {
    expect(isSurveyCard({ entityId: '', entityTypeId: 1046 }, SURVEY)).toBe(true)
  })

  it('не принимает поле, заведённое на сделке', () => {
    // ⚠ Главный случай. Тип виден администратору в списке типов полей, и поле можно
    // поставить на сделку — тогда номер элемента это номер сделки, и мы показали бы
    // «Опрос» с тем же номером: чужой результат, выглядящий правдоподобно.
    expect(isSurveyCard({ entityId: 'CRM_DEAL', entityTypeId: 2 }, SURVEY)).toBe(false)
  })

  it('в `ENTITY_ID` стоит `id` смарт-процесса, а не `entityTypeId`', () => {
    // Проект уже обжигался на этой паре: имена полей и `ENTITY_ID` берут `id`,
    // элементы и точки встраивания — `entityTypeId`.
    expect(isSurveyCard({ entityId: 'CRM_1046', entityTypeId: null }, SURVEY)).toBe(false)
  })

  it('без признаков отказывает', () => {
    // Показать чужой результат хуже, чем не показать ничего.
    expect(isSurveyCard({ entityId: '', entityTypeId: null }, SURVEY)).toBe(false)
  })
})

/** Имена элементов раздела в том порядке, в каком они уйдут в портал. */
function namesIn(sections: Record<string, unknown>[] | null, section = CARD_RESULT_SECTION): string[] {
  const found = sections?.find(s => s.name === section)
  return ((found?.elements ?? []) as { name: string }[]).map(e => e.name)
}

describe('раскладка карточки с нуля', () => {
  const widget = buildFieldName(SURVEY.id, SURVEY_RESULT_FIELD)
  const json = [buildFieldName(SURVEY.id, 'SCORES'), buildFieldName(SURVEY.id, 'ANSWERS')]

  it('ставит виджет ВМЕСТО JSON-полей', () => {
    // Второй шаг #81: виджет живьём показал результат (владелец, 28.09), и JSON в карточке больше
    // не нужен. Данные JSON-полей на элементе остаются — виджет читает именно их.
    const names = namesIn(buildCardSections(SURVEY.id, true))

    expect(names).toContain(widget)
    for (const name of json) expect(names).not.toContain(name)
  })

  it('показывает виджет всегда, хотя значения у поля нет', () => {
    // ⚠ Без `optionFlags: 1` карточка прячет пустое поле в режиме просмотра, а значения
    // у поля нашего типа не бывает никогда — виджет не открылся бы ни разу.
    const elements = buildCardSections(SURVEY.id, true)
      .flatMap(s => s.elements as { name: string, optionFlags?: number }[])

    expect(elements.find(e => e.name === widget)?.optionFlags).toBe(1)
  })

  it('без поля виджета его и не ставит', () => {
    // Тип не зарегистрировался — имя несуществующего поля в раскладке было бы пустым местом.
    const names = namesIn(buildCardSections(SURVEY.id, false))

    expect(names).not.toContain(widget)
    for (const name of json) expect(names).toContain(name)
  })
})

/** The sections a `write` plan sends to the portal, with their elements. */
function sectionsOf(plan: ReturnType<typeof planSurveyCard>): { name: string, elements: { name: string, optionFlags?: number }[] }[] {
  expect(plan.kind).toBe('write')
  return (plan as { sections: unknown }).sections as { name: string, elements: { name: string, optionFlags?: number }[] }[]
}

/** Names of every element of the layout, section by section — what goes back to the portal. */
function layoutOf(plan: ReturnType<typeof planSurveyCard>): string[][] {
  expect(plan.kind).toBe('write')
  return (plan as { sections: Record<string, unknown>[] }).sections.map(section => (section.elements as { name: string }[]).map(e => e.name))
}

describe('ревизия 6: свои поля в раскладке, которая уже стоит', () => {
  const f = (postfix: string) => buildFieldName(SURVEY.id, postfix)

  /** Раскладка, как её поставила прежняя версия приложения, плюс чужой раздел клиента. */
  function ours(): Record<string, unknown>[] {
    return [
      { name: 'survey_about', title: 'Об опросе', type: 'section', elements: [{ name: 'TITLE', optionFlags: 1 }] },
      { name: 'survey_form', title: 'Анкета', type: 'section', elements: [{ name: f('TEMPLATE_CODE') }, { name: f('TEMPLATE_VERSION') }, { name: f('EXPIRES_AT') }] },
      {
        name: CARD_RESULT_SECTION,
        title: 'Результат',
        type: 'section',
        elements: [{ name: f('SCORE'), optionFlags: 1 }, { name: f('COMPLETED_AT') }, { name: f('RESULT'), optionFlags: 1 }, { name: f('SCORES') }, { name: f('ANSWERS') }],
      },
      { name: 'client_own', title: 'Своё', type: 'section', elements: [{ name: 'OPPORTUNITY', optionFlags: 1 }] },
    ]
  }

  /** Раскладка, как её собирает сам портал: «Об элементе» и «Дополнительно» со всеми нашими полями подряд. */
  function portalDefault(): Record<string, unknown>[] {
    return [
      { name: 'main', title: 'Об элементе', type: 'section', elements: [{ name: 'TITLE' }, { name: 'PARENT_ID_2' }] },
      {
        name: 'additional',
        title: 'Дополнительно',
        type: 'section',
        elements: ['TEMPLATE_CODE', 'TEMPLATE_VERSION', 'EXPIRES_AT', 'LINK', 'SCORE', 'COMPLETED_AT', 'ANSWERS', 'SCORES'].map(postfix => ({ name: f(postfix) })),
      },
    ]
  }

  it('ГЛАВНОЕ: наша раскладка — JSON уходит, ссылка встаёт после срока, остальное как было', () => {
    // Раскладка тестового портала 28.09 — ровно такая: виджет над JSON, ссылки нет вовсе,
    // потому что ревизия 4 завела поле, а в стоящую раскладку его не поставила.
    const plan = planSurveyCard({ result: ours() }, SURVEY.id, true)

    expect(layoutOf(plan)).toEqual([
      ['TITLE'],
      [f('TEMPLATE_CODE'), f('TEMPLATE_VERSION'), f('EXPIRES_AT'), f('LINK')],
      [f('SCORE'), f('COMPLETED_AT'), f('RESULT')],
      ['OPPORTUNITY'],
    ])
  })

  it('ГЛАВНОЕ: раскладка портала — виджет встаёт на место первого JSON-поля, а не в «Скрытые поля»', () => {
    // ⚠ Пересмотр решения PR #80, по слову владельца (#84, п. 15): правка знала только свой раздел
    // `survey_result`, и в раскладке, собранной порталом, виджет лёг в «Скрытые поля» — владелец
    // доставал его руками. Теперь в чужой раскладке трогаем свои поля, где бы они ни стояли.
    const plan = planSurveyCard({ result: portalDefault() }, SURVEY.id, true)

    expect(layoutOf(plan)[1]).toEqual([f('TEMPLATE_CODE'), f('TEMPLATE_VERSION'), f('EXPIRES_AT'), f('LINK'), f('SCORE'), f('COMPLETED_AT'), f('RESULT')])
    const placed = sectionsOf(plan)[1]!.elements.find(e => e.name === f('RESULT'))
    // Значения у поля нет никогда: без «показывать всегда» карточка его прятала бы.
    expect(placed?.optionFlags).toBe(1)
  })

  it('ГЛАВНОЕ: без поля виджета JSON не снимается — менеджер остался бы без ответов', () => {
    const plan = planSurveyCard({ result: ours().map(s => ({ ...s, elements: (s.elements as { name: string }[]).filter(e => e.name !== f('RESULT')) })) }, SURVEY.id, false)

    expect(layoutOf(plan)[2]).toEqual([f('SCORE'), f('COMPLETED_AT'), f('SCORES'), f('ANSWERS')])
    // Ссылка встаёт и так: её поле заводится вместе с остальными, виджет ей не нужен.
    expect(layoutOf(plan)[1]).toContain(f('LINK'))
  })

  it('ГЛАВНОЕ: чужое уходит обратно как пришло — разделы, поля, порядок и флаги', () => {
    // ⚠ Метод перезаписывает раскладку целиком и на всех пользователей: всё, что не наше, обязано
    // вернуться в портал без единого изменения.
    const before = ours()
    const plan = planSurveyCard({ result: ours() }, SURVEY.id, true) as { sections: Record<string, unknown>[] }

    expect(plan.sections[0]).toEqual(before[0])
    expect(plan.sections[3]).toEqual(before[3])
    expect(plan.sections.map(s => [s.name, s.title, s.type])).toEqual(before.map(s => [s.name, s.title, s.type]))
  })

  it('виджет и ссылку, которые клиент уже поставил, не двигает и не дублирует', () => {
    // Владелец положил виджет в свой раздел руками — там ему и место; флагов ему тоже не меняем.
    const layout = portalDefault()
    ;(layout[0]!.elements as { name: string }[]).push({ name: f('RESULT') })

    const plan = planSurveyCard({ result: layout }, SURVEY.id, true)

    expect(layoutOf(plan)[0]).toEqual(['TITLE', 'PARENT_ID_2', f('RESULT')])
    expect(layoutOf(plan).flat().filter(name => name === f('RESULT'))).toHaveLength(1)
    expect(layoutOf(plan).flat().filter(name => name === f('LINK'))).toHaveLength(1)
  })

  it('своих полей в раскладке нет вовсе — виджет и ссылка встают в конец первого раздела', () => {
    const plan = planSurveyCard({ result: [{ type: 'section', name: 'mine', title: 'Моё', elements: [{ name: 'TITLE' }] }, { type: 'section', name: 'more', title: 'Ещё', elements: [] }] }, SURVEY.id, true)

    expect(layoutOf(plan)).toEqual([['TITLE', f('RESULT'), f('LINK')], []])
  })

  it('клиент держал ответы в своём разделе — виджет встаёт туда, на их место', () => {
    // Где клиент смотрел ответы, там их теперь и покажет виджет — а не рядом с баллом в другом разделе.
    const layout = ours()
    layout[2]!.elements = [{ name: f('SCORE'), optionFlags: 1 }, { name: f('COMPLETED_AT') }]
    layout[3]!.elements = [{ name: 'OPPORTUNITY' }, { name: f('ANSWERS') }]

    const sections = layoutOf(planSurveyCard({ result: layout }, SURVEY.id, true))

    expect(sections[2]).toEqual([f('SCORE'), f('COMPLETED_AT')])
    expect(sections[3]).toEqual(['OPPORTUNITY', f('RESULT')])
  })

  it('без JSON-полей виджет встаёт после даты прохождения', () => {
    const layout = ours()
    layout[2]!.elements = [{ name: f('SCORE'), optionFlags: 1 }, { name: f('COMPLETED_AT') }]

    expect(layoutOf(planSurveyCard({ result: layout }, SURVEY.id, true))[2]).toEqual([f('SCORE'), f('COMPLETED_AT'), f('RESULT')])
  })

  it('узнаёт свои поля в любом написании имени', () => {
    // Портал отдаёт имя поля в трёх формах (разбор у `normalizeFieldName`): не узнав JSON-поле,
    // правка его оставила бы, а не узнав виджет — поставила бы второй.
    const layout = ours()
    layout[2]!.elements = [{ name: 'ufCrm8Score' }, { name: 'UF_CRM8_RESULT' }, { name: 'UF_CRM8_SCORES' }, { name: 'ufCrm8Answers' }]
    ;(layout[1]!.elements as { name: string }[]).push({ name: 'ufCrm8Link' })

    const sections = layoutOf(planSurveyCard({ result: layout }, SURVEY.id, true))

    expect(sections[2]).toEqual(['ufCrm8Score', 'UF_CRM8_RESULT'])
    // Ссылку в другом написании тоже узнаёт — второй не ставит.
    expect(sections.flat().filter(name => /link/i.test(name))).toEqual(['ufCrm8Link'])
  })

  it('ГЛАВНОЕ: стоящему без «показывать всегда» виджету флаг ставит — иначе он спрятан, а JSON снят', () => {
    // ⚠ Так бывает, когда виджет перетащили в карточку руками. Значения у поля не бывает никогда:
    // без флага карточка прячет его в режиме просмотра, а JSON правка снимает — менеджер не видел бы
    // ни виджета, ни ответов. Флаг — битовая маска: чужие биты сохраняются. Нашли программист,
    // `/review` и `/code-review` в панели PR #98.
    const withFlags = (flags: unknown) => {
      const layout = ours()
      layout[2]!.elements = [{ name: f('SCORE'), optionFlags: 1 }, { name: f('RESULT'), optionFlags: flags }, { name: f('ANSWERS') }]
      const plan = planSurveyCard({ result: layout }, SURVEY.id, true)
      return sectionsOf(plan)[2]!.elements.find(e => e.name === f('RESULT'))?.optionFlags
    }

    expect(withFlags('0')).toBe(1)
    expect(withFlags(undefined)).toBe(1)
    expect(withFlags(2)).toBe(3)
    // Флаг уже есть — строкой, как его отдаёт портал, — не трогаем.
    expect(withFlags('1')).toBe('1')
  })

  it('резервные якоря: виджет — после балла, ссылка — после версии или кода шаблона', () => {
    const layout = ours()
    layout[1]!.elements = [{ name: f('TEMPLATE_CODE') }, { name: f('TEMPLATE_VERSION') }]
    layout[2]!.elements = [{ name: f('SCORE'), optionFlags: 1 }]
    const byVersion = layoutOf(planSurveyCard({ result: layout }, SURVEY.id, true))

    expect(byVersion[1]).toEqual([f('TEMPLATE_CODE'), f('TEMPLATE_VERSION'), f('LINK')])
    expect(byVersion[2]).toEqual([f('SCORE'), f('RESULT')])

    layout[1]!.elements = [{ name: 'OPPORTUNITY' }, { name: f('TEMPLATE_CODE') }, { name: 'COMMENTS' }]
    expect(layoutOf(planSurveyCard({ result: layout }, SURVEY.id, true))[1]).toEqual(['OPPORTUNITY', f('TEMPLATE_CODE'), f('LINK'), 'COMMENTS'])
  })

  it('раздел, где были только JSON-поля, остаётся — пустым: чужой раздел не удаляем', () => {
    // Раздел клиента — его решение, даже опустевший. Что портал принимает раздел без элементов,
    // проверено живой репетицией (`docs/PROCESS.md`, раздел 9). Нашёл программист в панели PR #98.
    const layout = ours()
    layout[3]!.elements = [{ name: f('SCORES') }]

    expect(layoutOf(planSurveyCard({ result: layout }, SURVEY.id, true))[3]).toEqual([])
  })

  it('всё уже на месте — писать нечего', () => {
    const settled = planSurveyCard({ result: ours() }, SURVEY.id, true) as { sections: Record<string, unknown>[] }

    expect(planSurveyCard({ result: settled.sections }, SURVEY.id, true)).toEqual({ kind: 'keep' })
  })

  it('ГЛАВНОЕ: хоть один раздел в непонятной форме — не пишет ничего', () => {
    // ⚠ Отдав `[]` вместо непонятного `elements`, мы стёрли бы раздел у всех пользователей:
    // раскладка перезаписывается целиком. Нашёл `/code-review` в PR #80.
    const layout = ours()
    layout[2]!.elements = { 0: { name: f('SCORE') } }

    expect(planSurveyCard({ result: layout }, SURVEY.id, true)).toEqual({ kind: 'unreadable' })
    expect(planSurveyCard({ result: [null] }, SURVEY.id, true)).toEqual({ kind: 'unreadable' })
    expect(planSurveyCard({ result: 'испорчено' }, SURVEY.id, true)).toEqual({ kind: 'unreadable' })
    expect(planSurveyCard({ result: [] }, SURVEY.id, true)).toEqual({ kind: 'unreadable' })
    expect(planSurveyCard(null, SURVEY.id, true)).toEqual({ kind: 'unreadable' })
  })

  it('ГЛАВНОЕ: раздел, который отверг бы сам портал, не отправляет — иначе ревизия держалась бы вечно', () => {
    // ⚠ Проверка — ровно та, что у `set`: без `title`, без `name`, с `type` не `section`, элемент без
    // `name`. Эти отказы портал отдаёт с пустым кодом, а пустой код мы считаем повторимым: портал
    // стоял бы на ревизии 5 и обустраивался каждый час впустую. Нашёл `/code-review` в панели PR #98.
    const broken = [
      (section: Record<string, unknown>) => ({ ...section, title: undefined }),
      (section: Record<string, unknown>) => ({ ...section, name: '' }),
      (section: Record<string, unknown>) => ({ ...section, type: 'tab' }),
      (section: Record<string, unknown>) => ({ ...section, elements: [{ optionFlags: 1 }] }),
    ]
    for (const spoil of broken) {
      const layout = ours()
      layout[3] = spoil(layout[3]!)

      expect(planSurveyCard({ result: layout }, SURVEY.id, true)).toEqual({ kind: 'unreadable' })
    }
  })
})
