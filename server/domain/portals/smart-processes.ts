import { ownerLabel, SURVEY_SP_TITLE, TEMPLATE_SP_TITLE } from '../../../shared/portal-names'

// Названия живут в `shared/`: по ним же пишутся тексты страниц приложения (разбор — в шапке
// `shared/portal-names.ts`). Здесь повторный вывоз, чтобы у вызывающих на сервере не менялись импорты.
export { SURVEY_SP_TITLE, TEMPLATE_SP_TITLE }

/**
 * The two smart processes this app keeps in the portal, and the pure planning around them.
 *
 * Их ровно два — «Шаблон опроса» и «Результат опросов» (до ревизии 4 — «Опрос»), — и это
 * не стилистика: на Базовом тарифе лимит
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

/**
 * Прежние заголовки — до ревизии 4.
 *
 * ⚠ Поиск узнаёт и их. Портал, обустроенный раньше, мог потерять наш идентификатор
 * (переустановка почистила `app.option`), а смарт-процесс на нём остался со старым названием.
 * Не узнав его, мы создали бы второй — и съели лимит тарифа, который не наш.
 */
export const LEGACY_TEMPLATE_SP_TITLES: readonly string[] = ['Шаблон опроса']
export const LEGACY_SURVEY_SP_TITLES: readonly string[] = ['Опрос']

/**
 * Titles a smart process is searched by, current one first.
 *
 * ⚠ Готовыми списками, а не сборкой на месте: искать надо в двух местах — при обустройстве
 * и в операторских командах переноса анкет, — и следующее переименование, дописанное в одно
 * из них, разошлось бы с другим: `migrate:templates` перестал бы находить смарт-процесс,
 * который находит установка. Нашёл `/code-review` в PR #87.
 */
export const TEMPLATE_SP_TITLES: readonly string[] = [TEMPLATE_SP_TITLE, ...LEGACY_TEMPLATE_SP_TITLES]
export const SURVEY_SP_TITLES: readonly string[] = [SURVEY_SP_TITLE, ...LEGACY_SURVEY_SP_TITLES]

/** Какой из двух смарт-процессов: у них разные возможности (`buildCreateSmartProcessCall`). */
export type SmartProcessKind = 'template' | 'survey'

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

/**
 * Ревизия обустройства: что именно эта версия кода делает с порталом.
 *
 * ⚠ ЗАЧЕМ. Всё, что настраивает портал — смарт-процессы, поля, связь со сделкой, раскладка
 * карточки, точки встраивания, — делает `provisionWithCall`, а зовут его только при установке,
 * по кнопке «доустроить» и при долечивании сломанного портала. Портал в статусе `active`
 * не обустраивается больше НИКОГДА. То есть обновление приложения не меняло настройку портала
 * вообще: вторая вкладка, добавленная релизом, не появлялась ни у одного уже установленного
 * клиента. Issue #75, найдено на живом выкате.
 *
 * ⚠ КОГДА УВЕЛИЧИВАТЬ: всякий раз, когда обустройство начинает делать на портале что-то новое
 * или иначе — новое поле, новая точка встраивания, изменённая связь. Не увеличив, вы получите
 * код, который работает у новых клиентов и молчит у старых, и разницу между ними будет
 * не видно ниоткуда.
 *
 * | Ревизия | Что появилось |
 * |---|---|
 * | 1 | всё до вкладки конструктора |
 * | 2 | вкладка конструктора в карточке «Шаблона опроса» (PR #74) |
 * | 3 | поле своего типа «Результат опроса» на «Опросе» и виджет в раскладке его карточки |
 * | 4 | префикс `[sh]` в названиях и подписях, поля закрыты от правки, у «Шаблона» выключены «Клиент» и роботы, поле «Ссылка на анкету» |
 */
export const PROVISION_REVISION = 4

/**
 * Ревизия, с которой в карточке «Опроса» стоит виджет результата.
 *
 * ⚠ Отдельной константой, а не `PROVISION_REVISION`: правка чужой раскладки — разовая миграция
 * порталов, обустроенных ДО неё. Сравнивая с текущей ревизией, мы повторяли бы правку при каждом
 * следующем подъёме — и возвращали бы виджет клиенту, который его убрал.
 */
export const RESULT_FIELD_REVISION = 3

/**
 * Ревизия, с которой наше на портале помечено префиксом `[sh]` и закрыто от правки.
 *
 * ⚠ Разовая миграция порталов, обустроенных раньше, — по той же причине, что у виджета:
 * повторяя переименование при каждом подъёме, мы спорили бы с администратором, который
 * назвал смарт-процесс по-своему. Новые порталы получают всё это сразу при создании.
 */
export const OWNERSHIP_REVISION = 4

/** Пользовательское поле смарт-процесса. */
export interface SmartProcessField {
  /**
   * Только постфикс. Полное имя собирается на портале: `UF_CRM_<id СП>_<постфикс>`,
   * а `id` у каждого портала свой.
   */
  postfix: string
  userTypeId: 'string' | 'integer' | 'double' | 'date' | 'boolean' | 'url'
  /** Подпись БЕЗ метки владельца: её ставит `ownerLabel` при создании и при миграции. */
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
  // ⚠ Адрес анкеты — в CRM клиента, решение владельца 28.09 (issue #84, пункт 20): «это не
  // страшный секрет». У нас по-прежнему лежит только хеш токена — инвариант про НАШЕ хранилище
  // держится. Цена названа в `docs/PROCESS.md`: ответить вместо клиента может любой, кто видит
  // элемент. Тип `url` — ссылка кликается прямо из карточки; замерено на живом портале 28.09.
  { postfix: 'LINK', userTypeId: 'url', label: 'Ссылка на анкету' },
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
 * Постфикс поля с виджетом результата — поля НАШЕГО типа (`userfield-type.ts`).
 *
 * ⚠ Не в `SURVEY_FIELDS`, и это не забывчивость. Те поля стандартных типов и заводятся одним
 * циклом; у этого тип свой, и его полный код у каждого портала свой — он известен только
 * после регистрации типа и вопроса `app.info`. Поэтому заводит его отдельный шаг обустройства.
 * Значения у поля нет: виджет читает `ANSWERS` и `SCORES` того же элемента.
 */
export const SURVEY_RESULT_FIELD = 'RESULT'

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
export function buildCreateSmartProcessCall(title: string, kind: SmartProcessKind): PortalCall {
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
        // ⚠ Только «Опросу». «Шаблону» клиент и роботы не нужны: анкета ни с кем не связана,
        // а на карточке шаблона лишние вкладки и поля путают — владелец просил оставить там
        // один конструктор (issue #84, пункт 19). Прежде оба создавались одним вызовом, и
        // «Шаблон» получил «Клиента» и роботов просто за компанию.
        isClientEnabled: kind === 'survey',
        isAutomationEnabled: kind === 'survey',
        isBizProcEnabled: false,
        isRecyclebinEnabled: true,
      },
    },
  }
}

/**
 * Переименовать смарт-процесс.
 *
 * ⚠ Только `title`. `relations`, переданные в `crm.type.update`, перезаписываются ЦЕЛИКОМ
 * (документация метода), а без них связи не трогаются — замерено на живом портале 28.09:
 * после правки одного названия связь со сделкой на месте.
 */
export function buildRenameTypeCall(ref: SmartProcessRef, title: string): PortalCall {
  return { method: 'crm.type.update', params: { id: ref.id, fields: { title } } }
}

/**
 * Выключить у «Шаблона» то, что ему не нужно: «Клиента» и роботов.
 *
 * ⚠ Замерено 28.09: выключенный `isClientEnabled` снимает у типа связи с контактом
 * и компанией, остальные связи остаются. У шаблона других связей нет, и ни одно наше поле
 * на клиента не опирается.
 */
export function buildTemplateFeaturesCall(ref: SmartProcessRef): PortalCall {
  return { method: 'crm.type.update', params: { id: ref.id, fields: { isClientEnabled: 'N', isAutomationEnabled: 'N' } } }
}

/**
 * Создание одного пользовательского поля.
 *
 * Тип здесь шире, чем в `SmartProcessField`: кроме стандартных типов сюда приходит полный код
 * нашего собственного, `rest_<ID приложения>_<код>`, а он у каждого портала свой. Сами описания
 * полей остаются на узком перечне — опечатка в них по-прежнему ловится компилятором.
 */
export function buildCreateFieldCall(
  spTypeId: number,
  field: Omit<SmartProcessField, 'userTypeId'> & { userTypeId: string },
): PortalCall {
  return {
    method: 'userfieldconfig.add',
    params: {
      moduleId: 'crm',
      field: {
        entityId: buildFieldEntityId(spTypeId),
        fieldName: buildFieldName(spTypeId, field.postfix),
        userTypeId: field.userTypeId,
        editFormLabel: { ru: ownerLabel(field.label) },
        // ⚠ Все наши поля пишет только приложение. Открытые на правку, они позволяли вписать
        // мусор в ответы клиента и опубликовать шаблон в обход проверок правкой «Состояния» —
        // владелец сделал это на живой проверке (issue #84, пункты 12 и 16). Запись через REST
        // флаг не закрывает: замерено 28.09 — `crm.item.add` и `.update` пишут в такое поле.
        editInList: 'N',
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
export function findTypeByTitle(
  types: readonly Record<string, unknown>[],
  titles: readonly string[],
): SmartProcessRef | null {
  // ⚠ Названия перебираются ПО ПОРЯДКУ, а не смарт-процессы: нынешнее название важнее
  // прежнего. Если на портале есть и «[sh] Результат опросов», и старый «Опрос», наш — первый.
  for (const title of titles) {
    for (const type of types) {
      if (typeof type.title !== 'string' || type.title.trim() !== title) continue
      const entityTypeId = Number(type.entityTypeId)
      const id = Number(type.id)
      if (Number.isInteger(entityTypeId) && entityTypeId > 0 && Number.isInteger(id) && id > 0) {
        return { entityTypeId, id }
      }
    }
  }
  return null
}

/** Title of the smart process with this `id`; `null` when it is not in the list. */
export function readTypeTitle(types: readonly Record<string, unknown>[], id: number): string | null {
  const type = types.find(type => Number(type.id) === id)
  return typeof type?.title === 'string' ? type.title : null
}

/**
 * Whether the smart process has «Client» or automation switched on; `null` when unknown.
 *
 * ⚠ `null` и при флаге непонятной формы, а не «выключено». Документация отдаёт флаги строками
 * `Y`/`N`, но прочитай мы незнакомую форму как «выключено», у «Шаблона» с включёнными роботами
 * они так и остались бы включёнными — молча. Тот же приём «не гадать», что у разбора связей
 * (`readTypeRelations`). Нашёл программист в панели ревью PR #87.
 */
export function hasTemplateExtras(types: readonly Record<string, unknown>[], id: number): boolean | null {
  const type = types.find(type => Number(type.id) === id)
  if (type === undefined) return null
  const client = readFlag(type.isClientEnabled)
  const automation = readFlag(type.isAutomationEnabled)
  if (client === null || automation === null) return null
  return client || automation
}

function readFlag(value: unknown): boolean | null {
  if (value === 'Y' || value === true) return true
  if (value === 'N' || value === false) return false
  return null
}

/**
 * Язык подписей в списках полей.
 *
 * ⚠ БЕЗ НЕГО ПОДПИСЕЙ В ОТВЕТЕ НЕТ ВОВСЕ. Замерено 28.09 на тестовом портале: `userfieldconfig.list`
 * без `select.language` и `crm.<entity>.userfield.list` без `filter.LANG` отдают поля без
 * `editFormLabel`. Миграция ревизии 4 сравнивала бы подпись с пустотой и переписывала каждое
 * поле при каждом прогоне — в том числе на свежей установке, под общим пределом времени.
 * Документация показывает язык во всех примерах обоих методов, но словами об этом не говорит.
 * Нашли `/review` и `/code-review` в PR #87. Поля без подписи фильтр по языку не отбрасывает —
 * замерено там же.
 */
export const FIELD_LABEL_LANGUAGE = 'ru'

/** A smart-process field as `userfieldconfig.list` returns it. */
export interface ExistingField {
  /** Settings id — the one `userfieldconfig.update` wants. `0` — the portal did not name it. */
  id: number
  name: string
  userTypeId: string
  /** Empty — the portal did not say. */
  editInList: 'Y' | 'N' | ''
  /** Russian card label. Empty — not set, or the list was read without a language. */
  label: string
}

/**
 * Lists one page of a smart process's fields, labels included.
 *
 * ⚠ С языком — без него подписей в ответе нет (`FIELD_LABEL_LANGUAGE`). Форма `select`
 * взята из примеров документации метода: `{ 0: '*', language: 'ru' }`.
 */
export function buildListSpFieldsCall(spTypeId: number, start = 0): PortalCall {
  return {
    method: 'userfieldconfig.list',
    params: {
      moduleId: 'crm',
      select: { 0: '*', language: FIELD_LABEL_LANGUAGE },
      filter: { entityId: buildFieldEntityId(spTypeId) },
      ...(start === 0 ? {} : { start }),
    },
  }
}

/** Fields from a `userfieldconfig.list` response. Nameless ones are skipped. */
export function readFields(response: unknown): ExistingField[] {
  const fields = (response as { result?: { fields?: unknown } } | null)?.result?.fields
  if (!Array.isArray(fields)) return []
  return fields
    .map(field => field as Record<string, unknown> | null)
    .filter(field => typeof field?.fieldName === 'string' && field.fieldName !== '')
    .map((field) => {
      const id = Number(field!.id)
      return {
        id: Number.isInteger(id) && id > 0 ? id : 0,
        name: field!.fieldName as string,
        userTypeId: typeof field!.userTypeId === 'string' ? field!.userTypeId : '',
        editInList: readEditInList(field!.editInList),
        label: readRuLabel(field!.editFormLabel),
      }
    })
}

function readEditInList(value: unknown): ExistingField['editInList'] {
  return value === 'Y' || value === 'N' ? value : ''
}

function readRuLabel(value: unknown): string {
  const ru = (value as { ru?: unknown } | null | undefined)?.ru
  return typeof ru === 'string' ? ru : ''
}

/** What it takes to close our fields and put the owner mark on their labels. */
export interface FieldOwnershipPlan {
  calls: PortalCall[]
  /**
   * Наши поля, которые надо поправить, но нечем: портал не назвал идентификатор настроек.
   *
   * ⚠ Отдельным списком, а не молчаливым пропуском. Пропусти мы их молча, «закрывать было
   * нечего» и «закрыть не смогли» выглядели бы одинаково — ноль вызовов, — и ревизия отметилась
   * бы с открытым полем навсегда. Нашли безопасность и `/review` в панели PR #87.
   */
  unaddressable: string[]
}

/**
 * Разовая миграция наших полей на портале, обустроенном до ревизии 4: закрыть от правки
 * и поставить подпись с меткой владельца.
 *
 * ⚠ Трогаем ТОЛЬКО свои поля — по имени из нашего же списка. Чужие поля клиента в том же
 * смарт-процессе не наши, и их настройки — его решение.
 *
 * ⚠ `existing` — поля, какими они были ДО того, как этот же запуск создал недостающие. Поле,
 * которого там нет, создано сейчас сборщиком создания — сразу закрытым и с меткой, — и править
 * его незачем. Отдельной ветки «не нашлось» поэтому нет: несовпадение имени здесь невозможно
 * без того же несовпадения при создании, а там оно не молчит — повторное создание падает
 * на дубликате, и обустройство отказывает целиком.
 *
 * ⚠ `editInList` в `userfieldconfig.update` документация не называет, но портал его принимает
 * и сохраняет — замерено 28.09 перечиткой, в том числе у полей типа `url` и нашего собственного
 * типа. Расхождение записано в `docs/PROCESS.md`, как велит правило проекта.
 *
 * Поле, у которого всё уже как надо, не трогаем: повторный запуск — ноль изменяющих вызовов.
 */
export function planFieldOwnership(
  spTypeId: number,
  ours: readonly { postfix: string, label: string }[],
  existing: readonly ExistingField[],
): FieldOwnershipPlan {
  const byName = new Map(existing.map(field => [normalizeFieldName(field.name), field]))
  const plan: FieldOwnershipPlan = { calls: [], unaddressable: [] }

  for (const field of ours) {
    const found = byName.get(normalizeFieldName(buildFieldName(spTypeId, field.postfix)))
    if (found === undefined) continue
    const label = ownerLabel(field.label)
    if (found.editInList === 'N' && found.label === label) continue
    if (found.id === 0) {
      plan.unaddressable.push(field.postfix)
      continue
    }
    plan.calls.push({
      method: 'userfieldconfig.update',
      params: { moduleId: 'crm', id: found.id, field: { editInList: 'N', editFormLabel: { ru: label } } },
    })
  }

  return plan
}

/**
 * Whether a `userfieldconfig.update` response confirms the field is closed and got the label we sent.
 *
 * ⚠ Проверяем ОТВЕТ, а не отсутствие исключения — тот же приём, что у связи со сделкой
 * (`ensureDealRelation`). Флаг `editInList` методом не документирован, и двухсотый ответ,
 * в котором поле осталось открытым, отчитался бы об успехе ровно там, где закрытие и есть
 * смысл миграции. Портал возвращает поле целиком — замерено 28.09.
 */
export function confirmsFieldOwnership(response: unknown, sent: PortalCall): boolean {
  const expected = readRuLabel((sent.params.field as { editFormLabel?: unknown } | undefined)?.editFormLabel)
  const field = (response as { result?: { field?: Record<string, unknown> | null } } | null)?.result?.field
  if (field === undefined || field === null || expected === '') return false
  return readEditInList(field.editInList) === 'N' && readRuLabel(field.editFormLabel) === expected
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
 * Контакт и компания — тоже системные типы CRM с постоянными номерами.
 *
 * Лежат рядом со сделкой по той же причине: номер типа не должен встречаться в коде
 * литералом. Читает их шапка анкеты — компания и контакт сделки, снятые при выпуске.
 */
export const CONTACT_ENTITY_TYPE_ID = 3
export const COMPANY_ENTITY_TYPE_ID = 4

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
  if (!read.parent.every(isRelation) || !read.child.every(isRelation)) return null

  return { parent: read.parent, child: read.child }
}

/**
 * Разобрать одну запись связи. `null` — форму не узнали, и тогда не трогаем ничего.
 *
 * ⚠ ОБА ПОЛЯ СТРОГО, И ВТОРОЕ — ТОЖЕ. Первая редакция этой правки останавливалась на непонятном
 * `entityTypeId`, а непонятный ФЛАГ молча превращала в «выключено» — и записывала его обратно
 * в портал как `'false'`. То есть ровно то стирание чужой настройки, против которого вся правка
 * и затевалась, просто на одно поле правее. Нашёл `/code-review` в PR #51.
 *
 * ⚠ `entityTypeId` проверяется `typeof`, а не `Number()`. Приведение пропускало мусор сквозь
 * гвард и превращало его в ДРУГУЮ настоящую связь: `Number(true) === 1` — это Лид, `['2']` —
 * Сделка. Клиент получил бы родительскую связь, которой никогда не настраивал, а это уже
 * не потеря, а порча. Живой портал отдаёт число (проверено `crm.type.get` 22.09).
 */
function toRelation(raw: unknown): TypeRelation | null {
  const record = raw as { entityTypeId?: unknown, isChildrenListEnabled?: unknown } | null
  if (record === null || typeof record !== 'object') return null

  const entityTypeId = record.entityTypeId
  if (typeof entityTypeId !== 'number' || !Number.isInteger(entityTypeId) || entityTypeId <= 0) return null

  const childrenList = readChildrenList(record.isChildrenListEnabled)
  if (childrenList === null) return null

  return { entityTypeId, childrenList }
}

/**
 * Прочитать флаг списка детей. `null` — форму не узнали.
 *
 * ⚠ ТОЛЬКО НАБЛЮДАВШИЕСЯ ФОРМЫ. Живой портал отдаёт строку `'Y'` или `'N'` — проверено
 * `crm.type.get` 22.09, и то же говорит документация. Промежуточная редакция принимала ещё
 * `true` и `1`, взятые по памяти, а не из наблюдения: список выглядел исчерпывающим, и именно
 * поэтому дыра рядом с ним (`'1'`, `'y'`, отсутствующий флаг) не бросалась в глаза.
 * `CLAUDE.md` про это говорит дважды — «не писать код на будущее» и «состав параметров берётся
 * из документации, а не из памяти».
 *
 * ⚠ Асимметрия портала остаётся в силе и здесь ни при чём: ПРИНИМАЕТ он `'true'`/`'false'`
 * (см. `toRelationParams`), а ОТДАЁТ `'Y'`/`'N'`. Принимать на чтении то, что он никогда
 * не присылал, значит угадывать.
 */
function readChildrenList(raw: unknown): boolean | null {
  if (raw === 'Y') return true
  if (raw === 'N') return false
  return null
}

function isRelation(value: TypeRelation | null): value is TypeRelation {
  return value !== null
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
export function buildCardSections(spTypeId: number, resultField: boolean): Record<string, unknown>[] {
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
      elements: [own('TEMPLATE_CODE'), own('TEMPLATE_VERSION'), own('STATE'), own('EXPIRES_AT'), own('LINK')],
    },
    {
      name: CARD_RESULT_SECTION,
      title: 'Результат',
      type: 'section',
      // ⚠ Виджет ПОКА НАД JSON-полями, а не вместо них, — и это первый шаг из двух, а не
      // компромисс. Что портал рисует пустое поле своего типа в режиме просмотра, живьём ещё
      // не проверено; убрав JSON сразу, мы при промахе оставили бы менеджера без ответов вовсе.
      // JSON уходит из раскладки вторым шагом, после живой проверки. Разбор — `docs/PROCESS.md`,
      // раздел 9. Решение по итогам панели ревью PR #80.
      elements: [
        { ...own('SCORE'), optionFlags: 1 },
        own('COMPLETED_AT'),
        // `optionFlags: 1` обязателен: значения у поля нет никогда, а пустое поле карточка
        // в режиме просмотра прячет — виджет не открылся бы ни разу.
        ...(resultField ? [{ ...own(SURVEY_RESULT_FIELD), optionFlags: 1 }] : []),
        own('SCORES'),
        own('ANSWERS'),
      ],
    },
  ]
}

/** Имя нашего раздела с результатом. По нему узнаём свой раздел в чужой раскладке. */
export const CARD_RESULT_SECTION = 'survey_result'

/**
 * Поставить виджет в раскладку, которая УЖЕ стоит на портале.
 *
 * ⚠ Существует ради порталов, установленных до поля своего типа. Раскладку мы ставим только
 * на пустом месте (`hasCardConfig`), значит у них она своя и новое поле в неё не попадёт
 * никогда: оно появится на элементе, но в карточке его не будет. Ровно тот класс отказа,
 * ради которого заводилась ревизия обустройства (issue #75), — новое не доезжает
 * до установленных.
 *
 * ⚠ Трогаем РОВНО ОДНО место — свой раздел `survey_result`, и только если виджета нет нигде.
 * Раскладка перезаписывается целиком и на всех пользователей, поэтому правило узкое:
 * - виджет уже где-то стоит (его поставили мы или переложил клиент) — ничего;
 * - нашего раздела нет (клиент собрал карточку по-своему) — ничего: его раскладка, его решение;
 * - хоть один раздел пришёл в непонятной форме — ничего: не разобрав, не пишем, как у связей;
 * - иначе виджет встаёт в наш раздел над первым JSON-полем (JSON остаётся — см. `buildCardSections`).
 *   Всё остальное уходит обратно в портал как пришло.
 *
 * ⚠ Вызывается ОДИН РАЗ — при переходе портала на ревизию 3, а не при каждом обустройстве.
 * Иначе клиент, сам убравший виджет, получал бы его обратно при каждой переустановке —
 * от этого `hasCardConfig` и защищает. Нашёл `/review`.
 *
 * `null` — менять нечего.
 */
export function planResultFieldInCard(current: unknown, spTypeId: number): Record<string, unknown>[] | null {
  const sections = (current as { result?: unknown } | null)?.result
  if (!Array.isArray(sections)) return null

  const elementsOf = (section: unknown) => (section as { elements?: unknown } | null)?.elements
  // ⚠ Не массив — не пишем. Отдав `[]` вместо непонятного, мы заменили бы раздел одним
  // виджетом и стёрли бы у всех пользователей то, что в нём было. Нашёл `/code-review`.
  if (!sections.every(section => Array.isArray(elementsOf(section)))) return null

  const same = (name: unknown, postfix: string) =>
    typeof name === 'string' && normalizeFieldName(name) === normalizeFieldName(buildFieldName(spTypeId, postfix))
  const rows = (section: unknown) => elementsOf(section) as (Record<string, unknown> | null)[]

  if (sections.some(section => rows(section).some(element => same(element?.name, SURVEY_RESULT_FIELD)))) return null

  const index = sections.findIndex(section => (section as { name?: unknown } | null)?.name === CARD_RESULT_SECTION)
  if (index === -1) return null

  const elements = [...rows(sections[index])]
  const at = elements.findIndex(element => same(element?.name, 'SCORES') || same(element?.name, 'ANSWERS'))
  elements.splice(at === -1 ? elements.length : at, 0, { name: buildFieldName(spTypeId, SURVEY_RESULT_FIELD), optionFlags: 1 })

  return sections.map((section, i) => i === index ? { ...(section as Record<string, unknown>), elements } : section as Record<string, unknown>)
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

/** Записать общую раскладку карточки — нашу с нуля или поправленную `planResultFieldInCard`. */
export function buildSetCardConfigCall(entityTypeId: number, sections: Record<string, unknown>[]): PortalCall {
  return {
    method: 'crm.item.details.configuration.set',
    params: { entityTypeId, scope: 'C', data: sections },
  }
}
