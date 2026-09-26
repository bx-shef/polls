import { buildFieldEntityId, type PortalCall, type SmartProcessRef } from './smart-processes'

/**
 * Our own user-field type: a widget of ours drawn inside a field of the portal's card.
 *
 * ⚠ ЗАЧЕМ. В карточке «Опроса» лежат два текстовых поля с JSON — «Ответы» и «Баллы
 * по секциям». Человек видит простыню в одну строку и не может прочитать из неё ничего.
 * Поле своего типа отдаёт на это место НАШУ страницу: она читает элемент и показывает
 * результат по-человечески. JSON-поля остаются — в них живут данные, а виджет их читает.
 *
 * ⚠ ЗАОДНО ЭТО И ЕСТЬ «ЗАКРЫТЬ ПОЛЕ НА РЕДАКТИРОВАНИЕ». Флага «только чтение» у обычных
 * типов полей в REST нет вовсе — проверено и по документации (`userfieldconfig.add`,
 * `userfieldconfig.update`, `crm.userfield.settings.fields` для `double`), и живьём
 * на тестовом портале. А поле своего типа нередактируемо по построению: значение ему
 * задаёт только вызов `setValue` из нашей же страницы, а мы его не делаем. Решение
 * владельца 26.09.
 *
 * ⚠ Требует КОНТЕКСТА ПРИЛОЖЕНИЯ и прав администратора; вебхуком тип не зарегистрировать
 * (документация метода). В батч `userfieldtype.*` не кладутся — `ERROR_BATCH_METHOD_NOT_ALLOWED`
 * есть в списке их ошибок.
 */

/**
 * Наш код типа — короткий, без префикса.
 *
 * ⚠ Поле создаётся по ПОЛНОМУ коду `rest_<ID приложения>_<код>`, а не по этому. Короткий
 * код в `userfieldconfig.add` даёт «Invalid custom type specified» — так написано в разборе
 * отказов официального гайда по виджету в поле. См. `fullTypeCode`.
 */
export const SURVEY_RESULT_TYPE = 'shef_survey_result'

/** Подпись типа в административном интерфейсе портала и подпись поля в карточке. */
export const SURVEY_RESULT_TITLE = 'Результат опроса'

/** Путь обработчика поля. Относительный: абсолютный собирается из публичного хоста. */
export const SURVEY_RESULT_HANDLER_PATH = '/uf/survey-result'

/**
 * Начальная высота поля в карточке, пикселей.
 *
 * ⚠ Это ТОЛЬКО начальное значение: дальше страница просит портал подогнать размер сама
 * (`$b24.parent.resizeWindowAuto`), потому что высота зависит от числа вопросов. Оставив одну
 * константу, мы получили бы либо обрезанный результат, либо пустое место под коротким.
 */
export const SURVEY_RESULT_HEIGHT = 220

/** Описание типа — одно на регистрацию и на правку, чтобы они не разошлись. */
function typeParams(handlerUrl: string): Record<string, unknown> {
  return {
    USER_TYPE_ID: SURVEY_RESULT_TYPE,
    HANDLER: handlerUrl,
    TITLE: SURVEY_RESULT_TITLE,
    DESCRIPTION: 'Результат опроса в читаемом виде. Заполняет приложение «Опросы».',
    OPTIONS: { height: SURVEY_RESULT_HEIGHT },
  }
}

/** Зарегистрировать тип. Отдельным вызовом: в батч метод не кладётся. */
export function buildRegisterTypeCall(handlerUrl: string): PortalCall {
  return { method: 'userfieldtype.add', params: typeParams(handlerUrl) }
}

/**
 * Сменить адрес обработчика у уже зарегистрированного типа.
 *
 * ⚠ ИМЕННО ПРАВКА, А НЕ «СНЯТЬ И ЗАРЕГИСТРИРОВАТЬ ЗАНОВО». Первая редакция делала второе —
 * по образцу вкладок, где `placement.unbind` безвреден. Здесь это не так: на типе висят
 * ПОЛЯ в карточках клиента, а что с ними делает `userfieldtype.delete`, документация
 * не говорит. Выяснять это на каждом обустройстве каждого портала — последнее, что стоит
 * делать; у метода правки параметр `HANDLER` есть прямым текстом.
 */
export function buildUpdateTypeCall(handlerUrl: string): PortalCall {
  return { method: 'userfieldtype.update', params: typeParams(handlerUrl) }
}

/** Спросить, какие типы зарегистрировало приложение. Наш один — страница одна. */
export function buildListTypesCall(): PortalCall {
  return { method: 'userfieldtype.list', params: {} }
}

/**
 * Наша регистрация, как её видит портал: адрес обработчика. `null` — типа нет.
 *
 * ⚠ Сверка по КОРОТКОМУ коду и точным совпадением. `userfieldtype.list` отдаёт ровно то,
 * что регистрировали (пример ответа в документации метода), — без префикса приложения.
 * Регистр приводим: портал хранит код в нижнем, и наш в нижнем, но полагаться на то,
 * что так будет всегда, незачем.
 */
export function findRegisteredType(response: unknown): { handler: string } | null {
  const result = (response as { result?: unknown } | null)?.result
  if (!Array.isArray(result)) return null

  for (const raw of result) {
    const row = raw as Record<string, unknown> | null
    const code = typeof row?.USER_TYPE_ID === 'string' ? row.USER_TYPE_ID.toLowerCase() : ''
    if (code === SURVEY_RESULT_TYPE) {
      return { handler: typeof row?.HANDLER === 'string' ? row.HANDLER : '' }
    }
  }
  return null
}

/**
 * Что сделать с регистрацией типа.
 *
 * ⚠ «Ничего», когда адрес совпал, — не экономия вызова. Метод правки знает отказ
 * «Handler already binded», и вызывать его с тем же адресом значит проверять на живом
 * портале, считает ли он занятым адрес, которым занят сам. Незачем.
 */
export function planTypeRegistration(existing: { handler: string } | null, handlerUrl: string): 'add' | 'update' | 'keep' {
  if (existing === null) return 'add'
  return existing.handler === handlerUrl ? 'keep' : 'update'
}

/**
 * Идентификатор приложения на этом портале — из ответа `app.info`.
 *
 * ⚠ Он ЛОКАЛЬНЫЙ: у каждого портала свой, поэтому полный код типа не константа, а вопрос
 * к порталу при каждом обустройстве.
 */
export function readAppId(response: unknown): number | null {
  const raw = (response as { result?: { ID?: unknown } } | null)?.result?.ID
  const id = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Полный код типа, по которому создаётся поле: `rest_<ID приложения>_<код>`.
 *
 * ⚠ Формат взят из официального гайда «Как встроить виджет в лид в виде пользовательского
 * поля»: там полный код собирается ровно так, из `app.info`. У самого `userfieldtype.add`
 * формат записан как «`rest__` + значение» — это та же строка с потерянным в вёрстке
 * идентификатором, а не другое правило. Сверять с `userfieldconfig.getTypes` отдельным
 * вызовом незачем: ошибись формат — портал откажет на создании поля, и отказ этот читается.
 */
export function fullTypeCode(appId: number): string {
  return `rest_${appId}_${SURVEY_RESULT_TYPE}`
}

/**
 * Открыто ли поле в карточке «Опроса», а не где-то ещё.
 *
 * ⚠ НЕ ПЕРЕСТРАХОВКА. Зарегистрированный тип виден администратору портала в списке типов
 * полей, и ничто не мешает завести поле «Результат опроса» на СДЕЛКЕ. Тогда портал откроет
 * виджет с идентификатором сделки, и без этой проверки мы прочитали бы «Опрос» с тем же
 * номером — чужой результат в чужой карточке, выглядящий совершенно правдоподобно.
 *
 * ⚠ Признаков два, и засчитывается любой. `ENTITY_ID` (`CRM_<id смарт-процесса>`) — то, что
 * обещает документация точки встраивания; `ENTITY_DATA.entityTypeId` — то, что соседнее
 * приложение (`nuxt-uf-legat-info`) читает на живых порталах. Нет ни одного — отказ: показать
 * чужой результат хуже, чем не показать ничего.
 */
export function isSurveyCard(owner: { entityId: string, entityTypeId: number | null }, survey: SmartProcessRef): boolean {
  return owner.entityId.toUpperCase() === buildFieldEntityId(survey.id)
    || owner.entityTypeId === survey.entityTypeId
}
