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
 * (документация метода). `userfieldtype.add` и `userfieldtype.update` в батч не кладутся —
 * `ERROR_BATCH_METHOD_NOT_ALLOWED` есть в списке их ошибок; список зовём отдельно заодно.
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

/** Что обустройству нужно знать о приложении на этом портале. */
export interface AppInfo {
  /** Локальный идентификатор приложения; `null` — портал его не назвал. */
  id: number | null
  /** Завершена ли установка (`installFinish`). */
  installed: boolean
}

/**
 * Разобрать ответ `app.info`.
 *
 * ⚠ ИДЕНТИФИКАТОР ЛОКАЛЬНЫЙ: у каждого портала свой, поэтому полный код типа не константа,
 * а вопрос к порталу при каждом обустройстве.
 *
 * ⚠ `INSTALLED` ЧИТАЕТСЯ, и это не формальность. Мастер установки обустраивает портал ДО
 * `installFinish()`, а до него поле своего типа портал не примет: официальный гайд прямо
 * называет незавершённую установку причиной отказа «Invalid custom type specified».
 * Первая редакция `INSTALLED` не смотрела — на каждом портале, поставленном из Маркета,
 * виджет не появился бы никогда. Нашли `/review` и `/code-review` независимо.
 *
 * Незавершённой считаем установку только по ЯВНОМУ отказу (`false`, `N`, `0`). Портал,
 * не приславший признак, считаем установленным: иначе шаг откладывался бы на нём вечно,
 * а отказ портала на создании поля и так читается.
 */
export function readAppInfo(response: unknown): AppInfo {
  const result = (response as { result?: { ID?: unknown, INSTALLED?: unknown } } | null)?.result
  const raw = result?.ID
  const id = Number(typeof raw === 'string' ? raw.trim() : raw)
  const flag = result?.INSTALLED
  const refused = flag === false || flag === 0 || (typeof flag === 'string' && ['n', '0', 'false'].includes(flag.trim().toLowerCase()))
  return {
    id: Number.isInteger(id) && id > 0 ? id : null,
    installed: !refused,
  }
}

/**
 * Полный код типа, по которому создаётся поле: `rest_<ID приложения>_<код>`.
 *
 * ⚠ Формат взят из официального гайда «Как встроить виджет в лид в виде пользовательского
 * поля»: там полный код собирается ровно так, из `app.info` (см. `readAppInfo`). У самого `userfieldtype.add`
 * формат записан как «`rest__` + значение» — это та же строка с потерянным в вёрстке
 * идентификатором, а не другое правило. Сверять с `userfieldconfig.getTypes` отдельным
 * вызовом незачем: ошибись формат — портал откажет на создании поля, и отказ этот читается.
 */
export function fullTypeCode(appId: number): string {
  return `rest_${appId}_${SURVEY_RESULT_TYPE}`
}

/**
 * Наш ли это тип у поля, которое уже стоит на «Опросе».
 *
 * ⚠ Имени поля мало. `UF_CRM_<id>_RESULT` может оказаться строковым полем клиента на
 * «усыновлённом» смарт-процессе либо нашим, но на типе со СТАРЫМ идентификатором приложения
 * — после переустановки с очисткой данных идентификатор новый. В обоих случаях в карточку
 * встало бы мёртвое поле. Нашли `/review` и `/code-review`. Чужое поле мы при этом НЕ удаляем
 * и не пересоздаём: в клиентском могут быть данные, а в старом нашем — нет ничего, что стоило бы
 * риска удаления на чужом портале. Виджета тогда просто нет, JSON-поля на месте.
 */
export function isOurFieldType(userTypeId: unknown, appId: number): boolean {
  return typeof userTypeId === 'string' && userTypeId.trim().toLowerCase() === fullTypeCode(appId)
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
 * чужой результат хуже, чем не показать ничего. Оговорка: в типах SDK (`IPlacementUF`)
 * `ENTITY_ID` — закрытый перечень сущностей, и варианта `CRM_<id>` в нём нет. Это не опровергает
 * документацию (перечень там просто старый), но и не подтверждает — вопрос к живой проверке.
 *
 * ⚠ ЭТО НЕ ГРАНИЦА ПРАВ. Оба признака присылает страница, и подделать их можно. Защищает функция
 * от ошибки администратора (поле поставили не туда), а не от злоумышленника: видит ли человек
 * элемент, решает портал его же токеном (`verifyItemAccess`) — и полагаться здесь на эту функцию
 * как на проверку доступа нельзя. Отметила панель ревью PR #80.
 */
export function isSurveyCard(owner: { entityId: string, entityTypeId: number | null }, survey: SmartProcessRef): boolean {
  return owner.entityId.toUpperCase() === buildFieldEntityId(survey.id)
    || owner.entityTypeId === survey.entityTypeId
}
