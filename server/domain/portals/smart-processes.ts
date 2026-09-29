import { LINK_FIELD_LABEL, ownerLabel, SURVEY_SP_TITLE, TEMPLATE_SP_TITLE } from '../../../shared/portal-names'

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
  /**
   * The default funnel, once revision 5 has set up native stages; absent — the old `STATE` field.
   *
   * ⚠ Он и есть признак «стадии включены и настроены»: без стадий портал `stageId` молча
   * отбрасывает (замерено 28.09), и писать его туда значило бы терять состояние. Разбор —
   * в `server/domain/portals/stages.ts`.
   */
  categoryId?: number
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
 * | 5 | штатные стадии у обоих смарт-процессов вместо своего поля «Состояние» (`server/domain/portals/stages.ts`) |
 * | 6 | карточка «Результата опросов»: виджет и «Ссылка на анкету» в любой раскладке, JSON-поля уходят из неё (`planSurveyCard`) |
 */
export const PROVISION_REVISION = 6

/**
 * Ревизия, с которой смарт-процессы живут на штатных стадиях.
 *
 * Отдельной константой по той же причине, что `OWNERSHIP_REVISION`: включение стадий, перенос
 * старого поля и его удаление — разовая миграция порталов, обустроенных до неё.
 */
export const STAGES_REVISION = 5

/**
 * Ревизия, с которой карточка «Результата опросов» показывает виджет и «Ссылку на анкету», а не JSON.
 *
 * ⚠ Отдельной константой, а не `PROVISION_REVISION`: правка чужой раскладки — разовая миграция
 * порталов, обустроенных ДО неё. Сравнивая с текущей ревизией, мы повторяли бы правку при каждом
 * следующем подъёме — и возвращали бы клиенту поля, которые он убрал сам.
 *
 * Заменила ревизию 3 в этой роли: правка ревизии 6 ставит и виджет, и в любую раскладку, так что
 * портал ниже третьей получает всё сразу (`planSurveyCard`).
 */
export const CARD_REVISION = 6

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
 * Our fields of a smart process: without `STATE` once it lives on native stages.
 *
 * ⚠ Со стадиями поле «Состояние» не заводится и не держится: иначе обустройство создавало бы
 * его заново после того, как миграция ревизии 5 его удалила (решение владельца «свои упраздни»).
 */
export function ourFields(fields: readonly SmartProcessField[], ref: SmartProcessRef): readonly SmartProcessField[] {
  return ref.categoryId === undefined ? fields : fields.filter(field => field.postfix !== 'STATE')
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
  { postfix: 'LINK', userTypeId: 'url', label: LINK_FIELD_LABEL },
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

/**
 * The camelCase name `crm.item.*` uses for our field without `useOriginalUfNames`: `ufCrm10State`.
 *
 * ⚠ Нужен ровно там, где без системных полей нельзя, а `select: ['*']` тянул бы лишнее: с флагом
 * `useOriginalUfNames: 'Y'` портал в узком `select` отдаёт одни пользовательские поля, без `id`
 * и `stageId` (разбор — «`crm.item.list` с `useOriginalUfNames` молча теряет системные поля»
 * в `docs/PROCESS.md`). Без флага узкий `select` в camelCase отдаёт и те и другие — замерено 28.09.
 */
export function camelFieldName(spTypeId: number, postfix: string): string {
  return buildFieldName(spTypeId, postfix)
    .toLowerCase()
    .split('_')
    .map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
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
 * Стадии включены — с ревизии 5, решение владельца «используй штатный механизм» (issue #84,
 * п. 21). До неё они были выключены намеренно, и довод тогда был верен: стадии — часть настроек
 * клиента, их переименовывают, двигают и удаляют. Поэтому приложение стадией только ПИШЕТ —
 * для канбана и роботов клиента, — а решения о публикации и о ссылке принимает по закрытым полям
 * и своей базе. Разбор — в `server/domain/portals/stages.ts`.
 */
export function buildCreateSmartProcessCall(title: string, kind: SmartProcessKind): PortalCall {
  return {
    method: 'crm.type.add',
    params: {
      fields: {
        title,
        // ⚠ Стадии — сразу, с ревизии 5: состояние элемента живёт в штатной стадии, а не в своём
        // поле (issue #84, п. 21). Воронка при этом одна: своих воронок нам не нужно.
        isStagesEnabled: true,
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
 * `true` — хоть один флаг известно включён; `false` — оба известно выключены; `null` — смарт-
 * процесса нет в списке либо флаг непонятной формы, и включённого среди понятных нет.
 *
 * ⚠ Непонятная форма — «не знаем», а не «выключено». Документация отдаёт флаги строками `Y`/`N`,
 * но прочитай мы незнакомую форму как «выключено», у «Шаблона» с включёнными роботами они так
 * и остались бы включёнными — молча. Тот же приём «не гадать», что у разбора связей
 * (`readTypeRelations`). Нашёл программист в панели ревью PR #87; что неизвестный второй флаг
 * не должен глушить известное «включено» у первого — `/code-review` во втором круге.
 */
export function hasTemplateExtras(types: readonly Record<string, unknown>[], id: number): boolean | null {
  const type = types.find(type => Number(type.id) === id)
  if (type === undefined) return null
  const client = readFlag(type.isClientEnabled)
  const automation = readFlag(type.isAutomationEnabled)
  if (client === true || automation === true) return true
  if (client === false && automation === false) return false
  return null
}

/** A yes/no flag as the portal sends it: `'Y'`/`'N'` or a boolean. `null` — anything else. */
export function readFlag(value: unknown): boolean | null {
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
 * Настройка карточки «Результата опросов»: что видно и в каком порядке.
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
export function buildCardSections(spTypeId: number, resultField: boolean, staged = false): Record<string, unknown>[] {
  const own = (postfix: string) => ({ name: buildFieldName(spTypeId, postfix) })
  // Со стадиями состояние видно полосой стадий над карточкой, а своего поля у элемента нет вовсе.
  const form = staged ? ['TEMPLATE_CODE', 'TEMPLATE_VERSION', 'EXPIRES_AT', 'LINK'] : ['TEMPLATE_CODE', 'TEMPLATE_VERSION', 'STATE', 'EXPIRES_AT', 'LINK']

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
      elements: form.map(own),
    },
    {
      name: CARD_RESULT_SECTION,
      title: 'Результат',
      type: 'section',
      // ⚠ Виджет ВМЕСТО JSON-полей — второй шаг #81, после живой проверки виджета владельцем 28.09
      // («само поле — хорошо»). Не завелось поле виджета — JSON остаётся: без него менеджер остался бы
      // без ответов вовсе. Данные JSON-полей на элементе остаются всегда: виджет читает именно их.
      elements: [
        { ...own('SCORE'), optionFlags: 1 },
        own('COMPLETED_AT'),
        // `optionFlags: 1` обязателен: значения у поля нет никогда, а пустое поле карточка
        // в режиме просмотра прячет — виджет не открылся бы ни разу.
        ...(resultField ? [{ ...own(SURVEY_RESULT_FIELD), optionFlags: 1 }] : [own('SCORES'), own('ANSWERS')]),
      ],
    },
  ]
}

/** Имя нашего раздела с результатом в раскладке, которую мы ставим с нуля (`buildCardSections`). */
export const CARD_RESULT_SECTION = 'survey_result'

/**
 * What an edit of a card layout that is already on the portal comes to:
 * - `write` — write these sections: something of ours was placed or taken out;
 * - `keep` — nothing to change: everything of ours already stands as it should;
 * - `unreadable` — a section came in a shape we do not understand, and nothing is written.
 *
 * ⚠ Не разобрав, не пишем: `set` перезаписывает раскладку целиком и на всех пользователей, и, отдав
 * `[]` вместо непонятного `elements`, мы стёрли бы у всех то, что в разделе было. Нашёл `/code-review`
 * в PR #80. «Не понял» отделено от «нечего делать», чтобы первое дошло до журнала: нашли `/review`
 * и `/code-review` в панели PR #98.
 */
export type CardPlan = { kind: 'write', sections: Record<string, unknown>[] } | { kind: 'keep' } | { kind: 'unreadable' }

/**
 * What provisioning does to the survey card layout (`planSurveyCard`): a `CardPlan`, whose `write` may also be our
 * layout from scratch, or `foreign` — an adopted smart process whose layout is not ours to change.
 */
export type SurveyCardPlan = CardPlan | { kind: 'foreign' }

/** What `planSurveyCard` needs to know besides the layout itself. */
export interface SurveyCardInput {
  /** The widget field is on the portal, and it is of our type. */
  widget: boolean
  /** The smart process was found by title rather than created or remembered by id. */
  adopted: boolean
  /** The one-time revision 6 fix is due: the portal stands below `CARD_REVISION`. */
  due: boolean
  /** The smart process runs on native stages, so there is no state field to show. */
  staged: boolean
}

/** Our JSON fields that the widget shows in words; the card keeps them only while there is no widget. */
const CARD_JSON_FIELDS: readonly string[] = ['SCORES', 'ANSWERS']

/** Where to put one of our fields: before or after the first field of `postfixes` found in the layout. */
interface CardAnchor {
  postfixes: readonly string[]
  after: boolean
}

/**
 * Plans the survey card layout: ours from scratch where the portal holds none, and the one-time revision 6 fix of a standing one — the widget and the link in, JSON out.
 *
 * ⚠ Всё решение о раскладке — здесь, в домене: и «ставить ли с нуля», и «чья она». Первая редакция
 * держала половину правила в REST-слое, и её покрывал только сквозной тест с подделкой портала.
 * Нашёл `/code-review` во втором круге панели PR #98.
 *
 * ⚠ ПЕРЕСМОТР РЕШЕНИЯ PR #80, ПО СЛОВУ ВЛАДЕЛЬЦА (#84, п. 15). Там правка знала один-единственный
 * свой раздел `survey_result`, а в раскладке, собранной клиентом, не трогала ничего: «его раскладка,
 * его решение». На тестовом портале раскладку пересобрали, виджет лёг в «Скрытые поля», и владелец
 * доставал его руками; «Ссылка на анкету», заведённая ревизией 4, не встала в карточку ни одного
 * старого портала. Теперь правило другое: в чужой раскладке трогаем только СВОИ поля, где бы они
 * ни стояли:
 * - виджета нет нигде — он встаёт рядом с нашими полями результата: на место первого JSON-поля,
 *   иначе после даты прохождения или балла, а их нет — в конец первого раздела. Всегда
 *   с «показывать всегда»: значения у поля нет никогда, и пустое карточка прячет;
 * - JSON-поля уходят из любого раздела, но только когда поле виджета на портале есть (`widget`):
 *   без виджета менеджер остался бы без ответов. Данные на элементе остаются — виджет читает их;
 * - «Ссылки на анкету» нет нигде — она встаёт после «Ссылка действительна до», иначе после версии
 *   или кода шаблона, а их нет — в конец первого раздела;
 * - всё остальное — чужие разделы, чужие поля, порядок, флаги — уходит обратно как пришло.
 * Уже стоящие виджет и ссылку не двигаем: куда их поставил клиент, там им и место. Виджету лишь
 * добавляем «показывать всегда», если его нет, — без флага он спрятан, а JSON снят.
 *
 * ⚠ Разово, при переходе на ревизию 6 (`CARD_REVISION`): повторяясь при каждом обустройстве, правка
 * возвращала бы клиенту поля, которые он убрал сам.
 */
export function planSurveyCard(current: unknown, spTypeId: number, card: SurveyCardInput): SurveyCardPlan {
  // ⚠ Своей раскладки нет — ставим нашу целиком, но не усыновлённому: найденный по названию может
  // оказаться «Опросом» клиента, и наши разделы легли бы в его карточку у всех. Нашли `/review`
  // и `/code-review` в панели PR #98.
  if (!hasCardConfig(current)) return card.adopted ? { kind: 'foreign' } : { kind: 'write', sections: buildCardSections(spTypeId, card.widget, card.staged) }
  if (!card.due) return { kind: 'keep' }
  const sections = readCardLayout(current)
  if (sections === null) return { kind: 'unreadable' }

  const rows = (index: number) => sections[index]!.elements
  /** Section and position of the first field of `postfixes`, in layout order, or `null`. */
  const find = (postfixes: readonly string[]): [number, number] | null => {
    const ours = postfixes.map(postfix => isOurField(spTypeId, postfix))
    for (let section = 0; section < sections.length; section++) {
      const at = rows(section).findIndex(element => ours.some(is => is(element)))
      if (at !== -1) return [section, at]
    }
    return null
  }
  const place = (element: Record<string, unknown>, anchors: readonly CardAnchor[]) => {
    for (const anchor of anchors) {
      const found = find(anchor.postfixes)
      if (found === null) continue
      rows(found[0]).splice(found[1] + (anchor.after ? 1 : 0), 0, element)
      return
    }
    rows(0).push(element)
  }

  // ⚠ У УСЫНОВЛЁННОГО — только если раскладка уже знает хоть одно наше поле. Найденный по названию
  // чаще всего наш же, переживший переустановку, и его раскладка — наша: её надо довести, иначе он
  // не получил бы ни виджета, ни ссылки никогда. Но голое «Опрос» может оказаться смарт-процессом
  // клиента, и в его карточку, где наших полей нет, мы ничего не ставим: чужого не перенастраиваем.
  // Первая редакция не трогала усыновлённого вовсе и замораживала наш же (`/review` и `/code-review`
  // в панели PR #98). Виджет засчитывается, только когда поле нашего типа (`widget`): строковое
  // `RESULT` клиента на усыновлённом процессе заведение поля опознаёт как чужое, а засчитав его по
  // имени, мы поставили бы ссылку в карточку клиента (`/code-review` во втором круге).
  const own = SURVEY_FIELDS.map(field => field.postfix)
  if (card.adopted && find(card.widget ? [...own, SURVEY_RESULT_FIELD] : own) === null) return { kind: 'foreign' }

  const { widget } = card
  let changed = false
  const standing = find([SURVEY_RESULT_FIELD])
  if (widget && standing === null) {
    place({ name: buildFieldName(spTypeId, SURVEY_RESULT_FIELD), optionFlags: 1 }, [
      { postfixes: CARD_JSON_FIELDS, after: false },
      { postfixes: ['COMPLETED_AT'], after: true },
      { postfixes: ['SCORE'], after: true },
    ])
    changed = true
  }
  else if (widget && standing !== null) {
    // ⚠ Стоящему виджету — «показывать всегда», если его нет. Значения у поля не бывает никогда,
    // и без флага карточка прячет его в режиме просмотра, а JSON ниже снимается: менеджер не видел
    // бы ни виджета, ни ответов. Так бывает, когда виджет перетащили в карточку руками. Флаг —
    // битовая маска: к прочим битам клиента только добавляем свой. Нашли программист, `/review`
    // и `/code-review` в панели PR #98.
    const element = rows(standing[0])[standing[1]]!
    const flags = Number(element.optionFlags) || 0
    if ((flags & 1) === 0) {
      rows(standing[0])[standing[1]] = { ...element, optionFlags: flags | 1 }
      changed = true
    }
  }
  if (widget) {
    const isJson = CARD_JSON_FIELDS.map(postfix => isOurField(spTypeId, postfix))
    for (const section of sections) {
      const kept = section.elements.filter(element => !isJson.some(is => is(element)))
      if (kept.length === section.elements.length) continue
      section.elements = kept
      changed = true
    }
  }
  if (find(['LINK']) === null) {
    place({ name: buildFieldName(spTypeId, 'LINK') }, [
      { postfixes: ['EXPIRES_AT'], after: true },
      { postfixes: ['TEMPLATE_VERSION'], after: true },
      { postfixes: ['TEMPLATE_CODE'], after: true },
    ])
    changed = true
  }
  return changed ? { kind: 'write', sections } : { kind: 'keep' }
}

/** A card section as `crm.item.details.configuration.set` accepts it back. */
interface CardSection extends Record<string, unknown> {
  name: string
  title: string
  type: 'section'
  elements: Record<string, unknown>[]
}

/**
 * Reads the card layout of a `crm.item.details.configuration.get` answer, or `null` when it is empty or not in the shape `set` takes back.
 *
 * ⚠ ПРОВЕРКА — РОВНО ТА, ЧТО У `set`: раздел — объект с непустыми строками `name` и `title`
 * и `type: 'section'`, у каждого элемента — непустая строка `name` (раздел «Errors» документации
 * метода, сверено 28.09). Отказы этой проверки портал отдаёт с ПУСТЫМ кодом ошибки, а пустой код
 * мы считаем повторимым (`isRetryableRefusal`): отправив раздел, который метод отвергнет, мы держали
 * бы ревизию вечно и обустраивали бы портал каждый час впустую. Нашёл `/code-review` в панели PR #98.
 * И `set` перезаписывает раскладку целиком и на всех: не разобрав, не пишем (нашёл `/code-review`
 * в PR #80). Разделы и их списки элементов — копии: читающий вправе их править.
 */
function readCardLayout(current: unknown): CardSection[] | null {
  const listed = (current as { result?: unknown } | null)?.result
  if (!Array.isArray(listed) || listed.length === 0) return null
  const sections: CardSection[] = []
  for (const raw of listed) {
    const section = raw as Record<string, unknown> | null
    if (section === null || typeof section !== 'object' || section.type !== 'section') return null
    if (!isFilledText(section.name) || !isFilledText(section.title) || !Array.isArray(section.elements)) return null
    const elements = section.elements as unknown[]
    if (!elements.every(element => element !== null && typeof element === 'object' && isFilledText((element as { name?: unknown }).name))) return null
    sections.push({ ...section, elements: [...elements] } as CardSection)
  }
  return sections
}

/** A predicate: is this layout element our field `postfix` of this smart process, however the portal spells it. */
function isOurField(spTypeId: number, postfix: string): (element: unknown) => boolean {
  const target = normalizeFieldName(buildFieldName(spTypeId, postfix))
  return (element) => {
    const name = (element as { name?: unknown } | null)?.name
    return typeof name === 'string' && normalizeFieldName(name) === target
  }
}

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * The card layout without our field: `keep` when there is none (or no saved layout at all), `unreadable` when the layout is not understood.
 *
 * ⚠ Раскладка хранит поля по имени, и удалённое поле в ней остаётся (замерено 28.09). Удаляя поле
 * «Состояние» миграцией ревизии 5, мы оставили бы в каждой уже сохранённой раскладке имя без поля.
 * Нашёл `/review` в панели PR #93. Убираем только его и только там, где оно есть: остальное в
 * раскладке — решение клиента.
 */
export function planDropFieldFromCard(current: unknown, spTypeId: number, postfix: string): CardPlan {
  // Своей раскладки нет — у умолчания портала и имени без поля нет.
  if (!hasCardConfig(current)) return { kind: 'keep' }
  // Не разобрав, не пишем: `set` перезаписывает раскладку целиком (разбор у `readCardLayout`).
  const sections = readCardLayout(current)
  if (sections === null) return { kind: 'unreadable' }
  const isTarget = isOurField(spTypeId, postfix)
  if (!sections.some(section => section.elements.some(isTarget))) return { kind: 'keep' }
  return { kind: 'write', sections: sections.map(section => ({ ...section, elements: section.elements.filter(element => !isTarget(element)) })) }
}

/** Прочитать общую настройку карточки. `scope: 'C'` — общая, не личная. */
export function buildReadCardConfigCall(entityTypeId: number): PortalCall {
  return { method: 'crm.item.details.configuration.get', params: { entityTypeId, scope: 'C' } }
}

/**
 * Whether the portal holds a saved common card layout, understood or not.
 *
 * ⚠ От этого зависит, тронем ли мы её вообще. `crm.item.details.configuration.set`
 * перезаписывает раскладку ЦЕЛИКОМ и на всех пользователей сразу — как `relations`.
 * Клиент, разложивший карточку под себя, получил бы нашу при каждой переустановке.
 * Поэтому ставим только на пустом месте: на живом портале умолчание отдаётся как `null`,
 * то есть «никто ничего не настраивал» отличимо от «настроено».
 *
 * ⚠ «Пусто» — только `null` и пустой список: стирать в них нечего. Всё прочее — настройка, пусть
 * и непонятная, и её разбирает `readCardLayout`. Первая редакция считала пустым всё, что не список:
 * ответ объектом — так PHP отдаёт список с дырой, и проект ловит эту форму у `elements` и в импорте, —
 * она приняла бы за пустоту и переписала бы раскладку клиента нашей целиком, на любой ревизии.
 * Нашёл `/code-review` во втором круге панели PR #98.
 */
function hasCardConfig(response: unknown): boolean {
  const result = (response as { result?: unknown } | null)?.result
  return result !== null && !(Array.isArray(result) && result.length === 0)
}

/** Записать общую раскладку карточки — нашу с нуля или поправленную `planSurveyCard`. */
export function buildSetCardConfigCall(entityTypeId: number, sections: Record<string, unknown>[]): PortalCall {
  return {
    method: 'crm.item.details.configuration.set',
    params: { entityTypeId, scope: 'C', data: sections },
  }
}
