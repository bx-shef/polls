/**
 * The two smart processes this app keeps in the portal, and the pure planning around them.
 *
 * Их ровно два — «Шаблон опроса» и «Опрос», — и это не стилистика: на Базовом тарифе лимит
 * 150 смарт-процессов на весь портал, и он не наш. Всё, что можно уложить в поле элемента,
 * укладывается в поле, а не в третий смарт-процесс.
 *
 * Здесь только чистые функции: состав полей, имена, планы вызовов и разбор ответов. Сами
 * вызовы — в `server/b24/provision.ts`, потому что домен не знает про REST.
 *
 * Форма и все неочевидные факты взяты у `client-bank-alfa-by`
 * (`app/config/distributionSp.ts`, `server/utils/distributionSpProvision.ts`), где они
 * подтверждены живыми порталами. Каждый отмечен ниже; у части из них есть и подтверждение
 * в документации — там, где оно есть, стоит ссылка, потому что «этого нет в документации»
 * хуже, чем отсутствие заметки: следующий поверит и не пойдёт проверять.
 */

/** Заголовки. По ним же смарт-процесс находится повторно, если наш идентификатор потерян. */
export const TEMPLATE_SP_TITLE = 'Шаблон опроса'
export const SURVEY_SP_TITLE = 'Опрос'

/**
 * Ссылка на смарт-процесс: нужны ОБА идентификатора, и это легко перепутать.
 *
 * `entityTypeId` адресует элементы (`crm.item.*`), `id` — настройки полей
 * (`userfieldconfig.*`) и входит в имя каждого поля. Сохранив один, мы не сможем
 * ни создать поле, ни прочитать его.
 */
export interface SmartProcessRef {
  entityTypeId: number
  id: number
}

/** Пользовательское поле смарт-процесса. */
export interface SmartProcessField {
  /**
   * Только постфикс. Полное имя собирается на портале: `UF_CRM_<id СП>_<постфикс>`,
   * а `id` у каждого портала свой.
   */
  postfix: string
  userTypeId: 'string' | 'integer' | 'double' | 'date' | 'boolean'
  label: string
  settings?: Record<string, unknown>
}

/**
 * Поля «Шаблона опроса» — по таблице «Что лежит в портале» в `docs/PROCESS.md`.
 *
 * Схема анкеты лежит текстовым полем с JSON: по шаблонам нужен список, фильтр, права
 * и история версий, а поиска по значению в `app.option` нет. Опубликованная версия
 * неизменяема, правка порождает новый элемент — отсюда `VERSION` и `STATE`.
 */
export const TEMPLATE_FIELDS: readonly SmartProcessField[] = [
  { postfix: 'CODE', userTypeId: 'string', label: 'Код шаблона' },
  { postfix: 'VERSION', userTypeId: 'integer', label: 'Номер версии' },
  { postfix: 'STATE', userTypeId: 'string', label: 'Состояние' },
  { postfix: 'PUBLISHED_AT', userTypeId: 'date', label: 'Дата публикации' },
  { postfix: 'SCHEMA', userTypeId: 'string', label: 'Схема анкеты (JSON)', settings: { ROWS: 10 } },
]

/**
 * Поля «Опроса» — приглашения и прохождения.
 *
 * Клиент и привязка к сделке приходят встроенными полями смарт-процесса
 * (`isClientEnabled`), поэтому своих для них нет. Состояния те же, что в нашем
 * кэш-индексе ссылок: created / sent / opened / completed / revoked / expired.
 */
export const SURVEY_FIELDS: readonly SmartProcessField[] = [
  { postfix: 'TEMPLATE_CODE', userTypeId: 'string', label: 'Код шаблона' },
  { postfix: 'TEMPLATE_VERSION', userTypeId: 'integer', label: 'Версия шаблона' },
  { postfix: 'STATE', userTypeId: 'string', label: 'Состояние' },
  { postfix: 'EXPIRES_AT', userTypeId: 'date', label: 'Ссылка действительна до' },
  { postfix: 'COMPLETED_AT', userTypeId: 'date', label: 'Дата прохождения' },
  // ⚠ PRECISION обязателен: без него `double` округляется до целого — подтверждено
  // соседом на живом портале. Балл 7,5 превратился бы в 8 и молча испортил отчёт.
  { postfix: 'SCORE', userTypeId: 'double', label: 'Итоговый балл', settings: { PRECISION: 2 } },
  // Ответы и баллы по секциям — JSON в текстовом поле, как схема у шаблона.
  // Решение владельца, и альтернативу стоит назвать: `docs/PROCESS.md` обещал поле на каждый
  // вопрос («балльные — числовыми полями ради отчётов»). Это дало бы родным отчётам портала
  // видеть каждый вопрос, но ценой ~119 полей на одном смарт-процессе уже при переносе,
  // и по новому полю на каждый новый вопрос каждой новой версии — при том что опубликованная
  // версия неизменяема, то есть список рос бы вечно и никогда не сокращался. Разрезы по
  // секциям и вопросам считает наш отчёт, а порталу для фильтров и роботов хватает `SCORE`.
  { postfix: 'ANSWERS', userTypeId: 'string', label: 'Ответы (JSON)', settings: { ROWS: 10 } },
  { postfix: 'SCORES', userTypeId: 'string', label: 'Баллы по секциям (JSON)', settings: { ROWS: 5 } },
]

/**
 * `entityId`, под которым создаётся поле смарт-процесса: `CRM_<id СП>`.
 *
 * ⚠ Именно `id` типа, а НЕ `entityTypeId`. Форма с `entityTypeId` отвергается порталом
 * с текстом «Вы не можете создавать пользовательские поля» — и это, в отличие от прочих
 * фактов здесь, есть в документации: туториал «Как создать пользовательское поле
 * в смарт-процессе» разбирает ровно эту путаницу, включая таблицу диагностики.
 * https://apidocs.bitrix24.ru/tutorials/field-types/how-to-add-user-field-to-spa.html
 */
export function buildFieldEntityId(spTypeId: number): string {
  return `CRM_${spTypeId}`
}

/** Полное имя поля: `UF_CRM_<id СП>_<постфикс>`. Тоже по `id` типа, не по `entityTypeId`. */
export function buildFieldName(spTypeId: number, postfix: string): string {
  return `UF_CRM_${spTypeId}_${postfix}`
}

/**
 * Каноничная форма имени для СВЕРКИ существования: без подчёркиваний, в нижнем регистре.
 *
 * ⚠ Без неё идемпотентность не работает. Поле создаётся как `UF_CRM_<id>_<ПОСТФИКС>`,
 * а `userfieldconfig.list` возвращает его в другой форме — слитной `UF_CRM<id>_<ПОСТФИКС>`
 * или camel `ufCrm<id><Постфикс>`. Прямое сравнение не совпадает, существующее поле
 * считается отсутствующим, повторное создание падает на дубликате и обрывает цикл
 * до полей, стоящих ниже. У соседа это вылезло на живом портале: часть полей
 * не появлялась НИКОГДА, сколько ни переустанавливай.
 */
export function normalizeFieldName(name: string): string {
  return name.replace(/_/g, '').toLowerCase()
}

/** Вызов, готовый к отправке в портал. Домен их только собирает, отправляет интеграция. */
export interface PortalCall {
  method: string
  params: Record<string, unknown>
}

/**
 * Создание смарт-процесса.
 *
 * ⚠ `entityTypeId` НЕ передаём: его назначает портал, и мы читаем его из ответа.
 * Документация подаёт это поле как то, что выбирает вызывающий (чётное ≥ 1030 либо
 * 128–192), но выбранный нами номер может быть занят на конкретном портале, а узнать
 * это заранее нельзя. У соседа поле не передаётся, и это работает на живых порталах.
 *
 * Стадии выключены намеренно: состояние держим своим полем `STATE`. Канбан по стадиям
 * выглядел бы удобнее, но стадии — часть настроек клиента, их переименовывают и удаляют,
 * и тогда наше состояние перестанет читаться.
 */
export function buildCreateSmartProcessCall(title: string): PortalCall {
  return {
    method: 'crm.type.add',
    params: {
      fields: {
        title,
        isStagesEnabled: false,
        isCategoriesEnabled: false,
        // ⚠ Даёт Контакт и Компанию, и ТОЛЬКО их. Прежний комментарий здесь обещал, что
        // этим же включается привязка к сделке, — это была неправда, и она стоила всей
        // отдачи ответа в карточку: у элемента «Опрос» поля `parentId2` просто не было,
        // `crm.item.add` молча его игнорировал, а комментарий в таймлайн не приходил никогда.
        // Документация метода говорит прямо: «При включенной опции у смарт-процесса
        // появляется предустановленная привязка к Контактам и Компаниям». Сделка заводится
        // отдельно, через `relations.parent` — см. `planDealRelation`.
        isClientEnabled: true,
        isAutomationEnabled: true,
        isBizProcEnabled: false,
        isRecyclebinEnabled: true,
      },
    },
  }
}

/** Создание одного пользовательского поля. */
export function buildCreateFieldCall(spTypeId: number, field: SmartProcessField): PortalCall {
  return {
    method: 'userfieldconfig.add',
    params: {
      moduleId: 'crm',
      field: {
        entityId: buildFieldEntityId(spTypeId),
        fieldName: buildFieldName(spTypeId, field.postfix),
        userTypeId: field.userTypeId,
        editFormLabel: { ru: field.label },
        ...(field.settings === undefined ? {} : { settings: field.settings }),
      },
    },
  }
}

/**
 * Какие поля ещё не созданы.
 *
 * Идемпотентность: повторный запуск после полного создания не планирует ничего, а
 * частично созданный смарт-процесс до-лечивается. Сверка идёт по нормализованному имени —
 * почему, объяснено у `normalizeFieldName`.
 */
export function planMissingFields(
  spTypeId: number,
  fields: readonly SmartProcessField[],
  existingNames: readonly string[],
): PortalCall[] {
  const present = new Set(existingNames.map(normalizeFieldName))
  return fields
    .filter(field => !present.has(normalizeFieldName(buildFieldName(spTypeId, field.postfix))))
    .map(field => buildCreateFieldCall(spTypeId, field))
}

/** Ссылка на созданный смарт-процесс из ответа `crm.type.add`; `null`, если ответ не тот. */
export function readCreatedRef(response: unknown): SmartProcessRef | null {
  const type = (response as { result?: { type?: unknown } } | null)?.result?.type as
    { entityTypeId?: unknown, id?: unknown } | undefined
  const entityTypeId = Number(type?.entityTypeId)
  const id = Number(type?.id)
  if (!Number.isInteger(entityTypeId) || entityTypeId <= 0) return null
  if (!Number.isInteger(id) || id <= 0) return null
  return { entityTypeId, id }
}

/** Смарт-процессы из ответа `crm.type.list`. Пустой массив, если ответ не тот. */
export function readTypes(response: unknown): Record<string, unknown>[] {
  const types = (response as { result?: { types?: unknown } } | null)?.result?.types
  return Array.isArray(types) ? types as Record<string, unknown>[] : []
}

/**
 * Найти наш смарт-процесс среди чужих по заголовку.
 *
 * Нужно для случая, когда идентификатор у нас потерян, а смарт-процесс на портале есть:
 * приложение переустановили, `app.option` почистили. Без этого поиска мы создали бы
 * второй такой же и съели лимит тарифа.
 *
 * ⚠ Заголовок — не признак владения. «Опрос» и «Шаблон опроса» — обычные слова, и совпасть
 * может смарт-процесс, который клиент завёл руками. Признака получше у нас нет:
 * `crm.type.add` не принимает `code` (проверено по документации метода), а собственных
 * полей у только что найденного типа может не быть и в том случае, когда он наш.
 * Поэтому исход помечается как «усыновление» и уходит в журнал предупреждением —
 * см. `ProvisionResult.adoptedTemplate` в `server/b24/provision.ts`.
 *
 * Сравнение — по обрезанному заголовку: портал отдаёт то, что ввёл человек, а хвостовой
 * пробел в названии превратил бы существующий смарт-процесс в «ненайденный» и породил
 * дубликат при лимите тарифа.
 */
export function findTypeByTitle(types: readonly Record<string, unknown>[], title: string): SmartProcessRef | null {
  for (const type of types) {
    if (typeof type.title !== 'string' || type.title.trim() !== title) continue
    const entityTypeId = Number(type.entityTypeId)
    const id = Number(type.id)
    if (Number.isInteger(entityTypeId) && entityTypeId > 0 && Number.isInteger(id) && id > 0) {
      return { entityTypeId, id }
    }
  }
  return null
}

/** Имена существующих полей из ответа `userfieldconfig.list`. */
export function readFieldNames(response: unknown): string[] {
  const fields = (response as { result?: { fields?: unknown } } | null)?.result?.fields
  if (!Array.isArray(fields)) return []
  return fields
    .map(field => (field as { fieldName?: unknown })?.fieldName)
    .filter((name): name is string => typeof name === 'string' && name !== '')
}

/**
 * Смещение следующей страницы списка, или `null`, если страниц больше нет.
 *
 * ⚠ Списки портала постраничные. Без перелистывания наш смарт-процесс, оказавшийся
 * на второй странице, не найдётся — и мы создадим дубликат. То же с полями: поле
 * со второй страницы будет запланировано заново и упадёт на дубликате.
 */
export function readNextOffset(response: unknown): number | null {
  const next = Number((response as { next?: unknown } | null)?.next)
  return Number.isInteger(next) && next > 0 ? next : null
}

/**
 * Идентификатор типа «Сделка». Системный, одинаковый на всех порталах.
 *
 * ⚠ Живёт здесь, а не рядом с вызовами приглашений, потому что нужен обеим сторонам:
 * тому, кто настраивает связь смарт-процесса, и тому, кто по ней ходит. Две копии одной
 * константы разъехались бы ровно в тот день, когда одну из них поправят.
 */
export const DEAL_ENTITY_TYPE_ID = 2

/**
 * Одна связь смарт-процесса с другим типом CRM.
 *
 * ⚠ `childrenList` — БУЛЕВО, и это не вкусовщина. Портал ОТДАЁТ флаг как `'Y'`/`'N'`,
 * а ПРИНИМАЕТ как `'true'`/`'false'` — формы разные, и на этом уже обожглись: первая
 * редакция отправляла `'Y'`, портал разбирал его как «не true» и записывал `'N'`.
 * Проверено на живом портале: отправили `'Y'` → в `crm.type.get` пришло `'N'`; пример
 * в документации `crm.type.add` шлёт именно `"true"`. Внутри держим булево, а обе чужие
 * формы живут по краям — в разборе и в сборке вызова, каждая в одном месте.
 *
 * `isPredefined` портал отдаёт, но обратно не посылается: это его пометка о том, что связь
 * появилась сама из `isClientEnabled`, а не наша настройка.
 */
export interface TypeRelation {
  entityTypeId: number
  /** Показывать ли в карточке родителя список его детей. */
  childrenList: boolean
}

/** Связи смарт-процесса: кто ему родитель и кто ребёнок. */
export interface TypeRelations {
  parent: TypeRelation[]
  child: TypeRelation[]
}

/** Прочитать настройки смарт-процесса. По `id` типа, не по `entityTypeId`. */
export function buildReadTypeCall(ref: SmartProcessRef): PortalCall {
  return { method: 'crm.type.get', params: { id: ref.id } }
}

/**
 * Достать связи из ответа `crm.type.get`.
 *
 * `null` — ответ не той формы. Это НЕ то же самое, что «связей нет»: пустые списки
 * означают известное состояние, а `null` — что мы ничего не знаем и трогать настройки
 * клиента вслепую нельзя.
 *
 * ⚠ ОДНА НЕРАЗОБРАННАЯ ЗАПИСЬ ОТМЕНЯЕТ ВЕСЬ РАЗБОР, и это исправление настоящего дефекта,
 * который уже был в проде. Прежняя редакция роняла непонятную запись через `filter`, а
 * `crm.type.update` перезаписывает `relations` ЦЕЛИКОМ — то есть связь, настроенную клиентом
 * руками и нами не узнанную, стирал ровно тот вызов, чей смысл «ничего не потерять».
 *
 * Правило модуля для нечитаемого ОТВЕТА уже было верным — «лучше не починить, чем стереть».
 * Теперь так же ведёт себя и нечитаемая ЗАПИСЬ. Цена отказа честная: на таком портале список
 * опросов в карточке сделки не включится, пока запись не станет понятной, — но чужие настройки
 * останутся целы. Вернуть непонятную запись порталу как есть тоже нельзя: он ОТДАЁТ флаг
 * как `'Y'`/`'N'`, а ПРИНИМАЕТ как `'true'`/`'false'`, и эхо погасило бы список детей
 * в чужой связи (проверено на живом портале в PR #38).
 *
 * ⚠ Читать связи можно только этим методом: `crm.type.list` отдаёт `relations: null`
 * у каждого типа — проверено на живом портале.
 */
export function readTypeRelations(response: unknown): TypeRelations | null {
  const relations = (response as { result?: { type?: { relations?: unknown } } } | null)
    ?.result?.type?.relations
  if (relations === null || typeof relations !== 'object') return null

  const { parent, child } = relations as { parent?: unknown, child?: unknown }
  if (!Array.isArray(parent) || !Array.isArray(child)) return null

  const read = { parent: parent.map(toRelation), child: child.map(toRelation) }
  if ([...read.parent, ...read.child].some(relation => relation === null)) return null

  return { parent: read.parent as TypeRelation[], child: read.child as TypeRelation[] }
}

function toRelation(raw: unknown): TypeRelation | null {
  const entityTypeId = Number((raw as { entityTypeId?: unknown } | null)?.entityTypeId)
  if (!Number.isInteger(entityTypeId) || entityTypeId <= 0) return null
  return { entityTypeId, childrenList: readChildrenList((raw as { isChildrenListEnabled?: unknown }).isChildrenListEnabled) }
}

/**
 * Прочитать флаг списка детей во всех формах, какие может принести портал.
 *
 * ⚠ Сверка ровно с `'Y'` была молчаливым понижением. Портал ОТДАЁТ `'Y'`/`'N'`, но ПРИНИМАЕТ
 * `'true'`/`'false'` — асимметрия проверена живьём в PR #38, и раз он говорит на двух языках
 * на входе, полагаться на один на выходе значит однажды прочитать включённый список как
 * выключенный. А дальше мы бы записали его обратно `'false'` и своими руками погасили список
 * детей в связи, которую клиент включил сам. Нераспознанное значение не считаем включением:
 * выключенный список — это неудобство, а стёртая настройка клиента — потеря.
 */
function readChildrenList(raw: unknown): boolean {
  return raw === 'Y' || raw === 'true' || raw === true || raw === 1
}

/**
 * Что отправить, чтобы «Опрос» стал дочерним к сделке. `null` — всё уже так, писать нечего.
 *
 * ⚠ САМОЕ ВАЖНОЕ ЗДЕСЬ — СЛИЯНИЕ, А НЕ ЗАМЕНА. Документация `crm.type.update` про `relations`
 * говорит: «Настройки необходимо передавать целиком, они полностью перезаписываются».
 * Отправив один свой пункт, мы стёрли бы всё остальное — в том числе предустановленные
 * Контакт и Компанию от `isClientEnabled` (проверено на живом портале: они там с пометкой
 * `isPredefined: 'Y'`) и любые связи, которые клиент настроил сам. Это как раз тот случай,
 * когда починка одной вещи ломает три чужих.
 *
 * ⚠ Поэтому же `null` при `current === null`: не прочитав связи, менять их нельзя. Лучше
 * не починить, чем стереть настройки клиента по ответу, формы которого мы не узнали.
 *
 * ⚠ Список детей в карточке сделки чиним, даже если связь уже есть. Отличить «клиент выключил
 * его сам» от «мы записали его неправильно» нечем, и выбран второй вариант осознанно: список
 * опросов в сделке — это то, ради чего связь и заводится, а не украшение. Первая редакция
 * оставила его выключенным на живом портале и не могла бы вылечить это никогда, потому что
 * сверяла только `entityTypeId`.
 */
export function planDealRelation(current: TypeRelations | null): TypeRelations | null {
  if (current === null) return null

  const deal = current.parent.find(relation => relation.entityTypeId === DEAL_ENTITY_TYPE_ID)
  if (deal !== undefined && deal.childrenList) return null

  const others = current.parent.filter(relation => relation.entityTypeId !== DEAL_ENTITY_TYPE_ID)
  return {
    parent: [...others, { entityTypeId: DEAL_ENTITY_TYPE_ID, childrenList: true }],
    child: current.child,
  }
}

/**
 * Записать связи целиком. Частичной записи у метода нет — см. `planDealRelation`.
 *
 * ⚠ Здесь и только здесь булево превращается в ту форму, которую портал ПРИНИМАЕТ.
 * Она не совпадает с той, которую он отдаёт.
 */
export function buildUpdateRelationsCall(ref: SmartProcessRef, relations: TypeRelations): PortalCall {
  return {
    method: 'crm.type.update',
    params: {
      id: ref.id,
      fields: {
        relations: {
          parent: relations.parent.map(toRelationParams),
          child: relations.child.map(toRelationParams),
        },
      },
    },
  }
}

function toRelationParams(relation: TypeRelation): Record<string, unknown> {
  return {
    entityTypeId: relation.entityTypeId,
    isChildrenListEnabled: relation.childrenList ? 'true' : 'false',
  }
}

/**
 * Настройка карточки «Опроса»: что видно и в каком порядке.
 *
 * ⚠ Существует потому, что умолчание портала прячет главное. На живом портале «Сделка»
 * и «Клиент» лежали в разделе «Скрытые поля»: карточка показывала код шаблона, состояние
 * и баллы — и НЕ показывала, по какой сделке опрос и кого спрашивали. Ровно те два ответа,
 * ради которых менеджер её и открывает.
 *
 * ⚠ Имена полей — `upperName` из `crm.item.fields`, а не то, чем адресуются элементы
 * в `crm.item.*`. Формы разные: карточка ждёт `PARENT_ID_2`, вызовы элементов — `parentId2`.
 * Все имена ниже сняты с живого портала этим методом, как велит документация
 * `crm.item.details.configuration.set`.
 *
 * ⚠ Клиент раскладывается на `CONTACT_ID` и `COMPANY_ID`: отдельного поля «Клиент»
 * в `crm.item.fields` нет, хотя интерфейс показывает его одной строкой.
 */
export function buildCardSections(spTypeId: number): Record<string, unknown>[] {
  const own = (postfix: string) => ({ name: buildFieldName(spTypeId, postfix) })

  return [
    {
      name: 'survey_about',
      title: 'Об опросе',
      type: 'section',
      elements: [
        // `optionFlags: 1` — «показывать всегда», в том числе когда значение пустое.
        // Для связи и клиента это важнее всего: пустое место на виду говорит, что связи нет,
        // а спрятанное поле не говорит ничего.
        { name: 'TITLE', optionFlags: 1 },
        { name: 'PARENT_ID_2', optionFlags: 1 },
        { name: 'CONTACT_ID', optionFlags: 1 },
        { name: 'COMPANY_ID', optionFlags: 1 },
        { name: 'ASSIGNED_BY_ID' },
      ],
    },
    {
      name: 'survey_form',
      title: 'Анкета',
      type: 'section',
      elements: [own('TEMPLATE_CODE'), own('TEMPLATE_VERSION'), own('STATE'), own('EXPIRES_AT')],
    },
    {
      name: 'survey_result',
      title: 'Результат',
      type: 'section',
      elements: [
        { ...own('SCORE'), optionFlags: 1 },
        own('COMPLETED_AT'),
        own('SCORES'),
        own('ANSWERS'),
      ],
    },
  ]
}

/** Прочитать общую настройку карточки. `scope: 'C'` — общая, не личная. */
export function buildReadCardConfigCall(entityTypeId: number): PortalCall {
  return { method: 'crm.item.details.configuration.get', params: { entityTypeId, scope: 'C' } }
}

/**
 * Есть ли уже общая настройка карточки.
 *
 * ⚠ От этого зависит, тронем ли мы её вообще. `crm.item.details.configuration.set`
 * перезаписывает раскладку ЦЕЛИКОМ и на всех пользователей сразу — как `relations`.
 * Клиент, разложивший карточку под себя, получил бы нашу при каждой переустановке.
 * Поэтому ставим только на пустом месте: на живом портале умолчание отдаётся как `null`,
 * то есть «никто ничего не настраивал» отличимо от «настроено».
 */
export function hasCardConfig(response: unknown): boolean {
  const result = (response as { result?: unknown } | null)?.result
  return Array.isArray(result) && result.length > 0
}

/** Записать общую раскладку карточки. */
export function buildSetCardConfigCall(entityTypeId: number, spTypeId: number): PortalCall {
  return {
    method: 'crm.item.details.configuration.set',
    params: { entityTypeId, scope: 'C', data: buildCardSections(spTypeId) },
  }
}
