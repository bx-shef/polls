import { describe, expect, it } from 'vitest'
import {
  CARD_RESULT_SECTION,
  SURVEY_RESULT_FIELD,
  buildCardSections,
  buildFieldName,
  planResultFieldInCard,
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

  it('ставит виджет НАД JSON-полями, а JSON пока оставляет', () => {
    // ⚠ Первый шаг из двух: что портал рисует пустое поле своего типа, живьём ещё не проверено.
    // Убрав JSON сразу, мы при промахе оставили бы менеджера без ответов. Панель ревью PR #80.
    const names = namesIn(buildCardSections(SURVEY.id, true))

    for (const name of json) {
      expect(names).toContain(name)
      expect(names.indexOf(widget)).toBeLessThan(names.indexOf(name))
    }
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

describe('виджет в раскладку, которая уже стоит', () => {
  /** Раскладка, как её поставила прежняя версия приложения, плюс чужой раздел клиента. */
  function installed(): Record<string, unknown>[] {
    return [
      { name: 'survey_about', title: 'Об опросе', type: 'section', elements: [{ name: 'TITLE', optionFlags: 1 }] },
      {
        name: CARD_RESULT_SECTION,
        title: 'Результат',
        type: 'section',
        elements: [
          { name: 'UF_CRM_8_SCORE', optionFlags: 1 },
          { name: 'UF_CRM_8_COMPLETED_AT' },
          { name: 'UF_CRM_8_SCORES' },
          { name: 'UF_CRM_8_ANSWERS' },
        ],
      },
      { name: 'client_own', title: 'Своё', type: 'section', elements: [{ name: 'OPPORTUNITY' }] },
    ]
  }

  it('ставит виджет над первым JSON-полем и ничего не убирает', () => {
    const planned = planResultFieldInCard({ result: installed() }, SURVEY.id)

    expect(namesIn(planned)).toEqual(['UF_CRM_8_SCORE', 'UF_CRM_8_COMPLETED_AT', 'UF_CRM_8_RESULT', 'UF_CRM_8_SCORES', 'UF_CRM_8_ANSWERS'])
  })

  it('остальное уходит обратно как пришло', () => {
    // ⚠ Метод перезаписывает раскладку целиком и на всех. Всё, что не наш раздел, обязано
    // вернуться в портал без единого изменения — иначе мы правим то, что настроил клиент.
    const before = installed()
    const planned = planResultFieldInCard({ result: installed() }, SURVEY.id)!

    expect(planned[0]).toEqual(before[0])
    expect(planned[2]).toEqual(before[2])
    expect(planned.map(s => s.name)).toEqual(before.map(s => s.name))
  })

  it('узнаёт JSON-поля в любом написании имени', () => {
    // Портал отдаёт имя поля в трёх формах (разбор у `normalizeFieldName`).
    const layout = installed()
    ;(layout[1]!.elements as { name: string }[])[2]!.name = 'UF_CRM8_SCORES'

    expect(namesIn(planResultFieldInCard({ result: layout }, SURVEY.id))).toEqual(
      ['UF_CRM_8_SCORE', 'UF_CRM_8_COMPLETED_AT', 'UF_CRM_8_RESULT', 'UF_CRM8_SCORES', 'UF_CRM_8_ANSWERS'],
    )
  })

  it('не пишет, если хоть один раздел пришёл в непонятной форме', () => {
    // ⚠ Отдав `[]` вместо непонятного `elements`, мы заменили бы раздел одним виджетом и стёрли бы
    // у всех пользователей то, что в нём было: раскладка перезаписывается целиком. Нашёл `/code-review`.
    const layout = installed()
    layout[1]!.elements = { 0: { name: 'UF_CRM_8_SCORE' } }

    expect(planResultFieldInCard({ result: layout }, SURVEY.id)).toBeNull()
  })

  it('дописывает виджет в конец, если JSON-поля клиент уже убрал', () => {
    const layout = installed()
    layout[1]!.elements = [{ name: 'UF_CRM_8_SCORE', optionFlags: 1 }]

    expect(namesIn(planResultFieldInCard({ result: layout }, SURVEY.id))).toEqual(['UF_CRM_8_SCORE', 'UF_CRM_8_RESULT'])
  })

  it('ничего не делает, если виджет уже где-то стоит', () => {
    // Клиент переложил виджет в свой раздел — это его решение, и второй экземпляр ему не нужен.
    const layout = installed()
    ;(layout[2]!.elements as { name: string }[]).push({ name: 'UF_CRM_8_RESULT' })

    expect(planResultFieldInCard({ result: layout }, SURVEY.id)).toBeNull()
  })

  it('ничего не делает, если нашего раздела нет', () => {
    // Клиент собрал карточку по-своему — его раскладка, его решение.
    const layout = installed().filter(s => s.name !== CARD_RESULT_SECTION)

    expect(planResultFieldInCard({ result: layout }, SURVEY.id)).toBeNull()
  })

  it.each<[unknown, string]>([
    [{ result: null }, 'раскладки нет — её ставит `buildCardSections`'],
    [{ result: 'испорчено' }, 'не список'],
    [null, 'ничего'],
  ])('не трогает непонятное (%#: %s)', (response) => {
    expect(planResultFieldInCard(response, SURVEY.id)).toBeNull()
  })
})
