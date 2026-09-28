import { CONTACT_ENTITY_TYPE_ID, DEAL_ENTITY_TYPE_ID } from './smart-processes'
import type { PortalCall } from './smart-processes'
import { ownerLabel } from './naming'

/**
 * The two fields we put on the client's own CRM entities: last survey score and its date.
 *
 * ⚠ ЗАЧЕМ ВООБЩЕ ЧУЖИЕ СУЩНОСТИ. Балл живёт на элементе смарт-процесса «Опрос», а он —
 * ДОЧЕРНЯЯ сущность сделки, и до его полей не дотягивается ничего из штатных средств портала:
 * ни фильтр в списке сделок («покажи сделки с оценкой ниже семи»), ни робот на стадии,
 * которому нужен порог тревоги, ни отчёт клиента. То есть обещанное клиенту «отфильтровать
 * сделки с плохой оценкой» без этих двух полей не работает вовсе. Issue #23.
 *
 * ⚠ ЦЕНА НАЗВАНА ВСЛУХ. Поле на сделке видит каждый сотрудник клиента в карточке каждой
 * сделки, и при удалении приложения оно не исчезает — пользовательские поля CRM удаляются
 * руками. Мы заводим ДВА и только на двух сущностях: сделка (там живёт проект) и контакт
 * (там живёт человек, которого спрашивали). Компанию сознательно не трогаем: у неё сделок
 * много, «последний балл» по компании — это балл случайной из них, то есть число,
 * которое выглядит осмысленным и не является таковым.
 *
 * ⚠ Создание требует ПРАВ АДМИНИСТРАТОРА: `crm.deal.userfield.add` отвечает
 * `Access denied: У пользователя нет административных прав` (документация метода).
 * У нас права проверяются при установке, так что это не новое требование, — но это ещё одно
 * место, где установка может пройти частично, и вызывающий обязан это увидеть.
 */

/**
 * Код поля БЕЗ префикса.
 *
 * ⚠ Префикс `UF_CRM_` портал добавляет САМ (документация `crm.deal.userfield.add`:
 * «К коду добавляется префикс UF_CRM_»). Передать имя уже с префиксом — получить
 * `UF_CRM_UF_CRM_…`, то есть поле, которое мы потом не найдём и создадим второй раз.
 */
export const LAST_SCORE_CODE = 'SHEF_SURVEY_SCORE'
export const LAST_SURVEY_AT_CODE = 'SHEF_SURVEY_AT'

/** Полное имя поля, каким его видно в `crm.item.*` с `useOriginalUfNames`. */
export function crmFieldName(code: string): string {
  return `UF_CRM_${code}`
}

/** Одно поле на сущности CRM клиента. */
export interface CrmField {
  code: string
  userTypeId: 'double' | 'date'
  label: string
  settings?: Record<string, unknown>
}

export const SCORE_FIELDS: readonly CrmField[] = [
  // ⚠ `PRECISION` обязателен: без него `double` округляется до целого — подтверждено
  // соседом на живом портале. Балл 7,5 стал бы восьмёркой, и фильтр «ниже семи» врал бы
  // ровно на той границе, ради которой его и настраивают.
  { code: LAST_SCORE_CODE, userTypeId: 'double', label: 'Оценка клиента', settings: { PRECISION: 2 } },
  // Дата без времени: фильтруют по дню, а не по минуте, и тип совпадает с `COMPLETED_AT`
  // на элементе «Опроса» — одна и та же величина не должна быть разного типа в двух местах.
  { code: LAST_SURVEY_AT_CODE, userTypeId: 'date', label: 'Дата последнего опроса' },
]

/** Сущность CRM, на которой заводим поля: чем создавать, чем перечислять, как обновлять. */
export interface CrmEntity {
  /** Для журнала и сообщений. */
  title: string
  /** `crm.<entity>.userfield.add` — создание. */
  addMethod: string
  /** `crm.<entity>.userfield.list` — перечисление уже существующих. */
  listMethod: string
  /** `crm.<entity>.userfield.update` — правка подписи при переходе на ревизию 4. */
  updateMethod: string
  /** Тот же тип для `crm.item.update`: обновляем сущности одним методом, как и везде. */
  entityTypeId: number
}

export const DEAL_ENTITY: CrmEntity = {
  title: 'сделка',
  addMethod: 'crm.deal.userfield.add',
  listMethod: 'crm.deal.userfield.list',
  updateMethod: 'crm.deal.userfield.update',
  entityTypeId: DEAL_ENTITY_TYPE_ID,
}

export const CONTACT_ENTITY: CrmEntity = {
  title: 'контакт',
  addMethod: 'crm.contact.userfield.add',
  listMethod: 'crm.contact.userfield.list',
  updateMethod: 'crm.contact.userfield.update',
  entityTypeId: CONTACT_ENTITY_TYPE_ID,
}

/** Сущности, на которых заводим поля. Компании здесь нет — см. шапку файла. */
export const SCORED_ENTITIES: readonly CrmEntity[] = [DEAL_ENTITY, CONTACT_ENTITY]

/** Перечислить пользовательские поля сущности. Страница за страницей — их бывает много. */
export function buildListFieldsCall(entity: CrmEntity, start = 0): PortalCall {
  return { method: entity.listMethod, params: start === 0 ? {} : { start } }
}

/**
 * Имена полей из ответа `crm.<entity>.userfield.list`.
 *
 * ⚠ Читаем `FIELD_NAME`, и он приходит УЖЕ С ПРЕФИКСОМ (`UF_CRM_…`) — так показано
 * в документации метода. Сравнивать его надо с `crmFieldName(code)`, а не с голым кодом.
 */
export function readCrmFieldNames(response: unknown): string[] {
  const result = (response as { result?: unknown } | null)?.result
  if (!Array.isArray(result)) return []

  return result
    .map(row => (row as { FIELD_NAME?: unknown })?.FIELD_NAME)
    .filter((name): name is string => typeof name === 'string' && name !== '')
}

/**
 * Что из наших полей на сущности ещё нет.
 *
 * ⚠ Сверка по НОРМАЛИЗОВАННОМУ имени, как и у полей смарт-процесса: портал уже показывал,
 * что отдаёт имя не в той форме, в какой принимает. Прямое сравнение однажды сочло бы
 * существующее поле отсутствующим, создание упало бы на дубликате, а идемпотентность
 * установки — главное её свойство — сломалась бы молча.
 */
export function planMissingCrmFields(
  entity: CrmEntity,
  fields: readonly CrmField[],
  existingNames: readonly string[],
): PortalCall[] {
  const present = new Set(existingNames.map(normalize))

  return fields
    .filter(field => !present.has(normalize(crmFieldName(field.code))))
    .map(field => buildCreateCrmFieldCall(entity, field))
}

/** Поле сущности, как его отдаёт `crm.<entity>.userfield.list`: для правки подписи. */
export interface ExistingCrmField {
  id: number
  name: string
  /** Подпись в карточке — строка или по языкам; сравниваем русскую. */
  label: string
}

/** Поля сущности с идентификатором и подписью. Без имени или без идентификатора — пропускаются. */
export function readCrmFields(response: unknown): ExistingCrmField[] {
  const result = (response as { result?: unknown } | null)?.result
  if (!Array.isArray(result)) return []

  const fields: ExistingCrmField[] = []
  for (const raw of result) {
    const row = raw as Record<string, unknown> | null
    const id = Number(row?.ID)
    if (typeof row?.FIELD_NAME !== 'string' || row.FIELD_NAME === '' || !Number.isInteger(id) || id <= 0) continue
    const label = row.EDIT_FORM_LABEL
    const ru = typeof label === 'string' ? label : (label as { ru?: unknown } | null | undefined)?.ru
    fields.push({ id, name: row.FIELD_NAME, label: typeof ru === 'string' ? ru : '' })
  }
  return fields
}

/**
 * Разовая миграция подписей наших полей на сделке и контакте: метка владельца `[sh]`.
 *
 * ⚠ Только свои поля, по коду. `EDIT_IN_LIST` здесь не трогаем: он стоял `N` с первого дня
 * (issue #23), и живой портал это подтвердил 28.09.
 *
 * ⚠ Все три подписи сразу: по документации `crm.<entity>.userfield.update` каждая перезаписывается
 * целиком, а не дополняется. Поменяв одну, мы оставили бы в фильтре и колонке старое имя.
 */
export function planCrmFieldLabels(
  entity: CrmEntity,
  fields: readonly CrmField[],
  existing: readonly ExistingCrmField[],
): PortalCall[] {
  const byName = new Map(existing.map(field => [normalize(field.name), field]))
  const calls: PortalCall[] = []

  for (const field of fields) {
    const found = byName.get(normalize(crmFieldName(field.code)))
    const label = ownerLabel(field.label)
    if (found === undefined || found.label === label) continue
    calls.push({
      method: entity.updateMethod,
      params: {
        id: found.id,
        fields: { LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label, EDIT_FORM_LABEL: label },
      },
    })
  }
  return calls
}

/**
 * Создать одно поле.
 *
 * ⚠ `SHOW_FILTER: 'Y'` — это и есть весь смысл задачи. Без него поле на сделке существует,
 * но в фильтре списка сделок его нет, то есть «покажи сделки с оценкой ниже семи»
 * по-прежнему не работает. Ровно та ошибка, при которой всё сделано и ничего не получилось.
 *
 * ⚠ `EDIT_IN_LIST: 'N'` — значение проставляет приложение, и правка руками означала бы
 * оценку клиента, которой клиент не ставил. Портал по умолчанию разрешает правку.
 */
export function buildCreateCrmFieldCall(entity: CrmEntity, field: CrmField): PortalCall {
  const label = ownerLabel(field.label)
  return {
    method: entity.addMethod,
    params: {
      fields: {
        FIELD_NAME: field.code,
        USER_TYPE_ID: field.userTypeId,
        LABEL: label,
        LIST_COLUMN_LABEL: label,
        LIST_FILTER_LABEL: label,
        EDIT_FORM_LABEL: label,
        SHOW_FILTER: 'Y',
        SHOW_IN_LIST: 'Y',
        EDIT_IN_LIST: 'N',
        ...(field.settings === undefined ? {} : { SETTINGS: field.settings }),
      },
    },
  }
}

/**
 * Записать последний балл и дату в сущность CRM.
 *
 * ⚠ Обновляем `crm.item.update` с `useOriginalUfNames`, а не `crm.deal.update`: так во всём
 * проекте, и имена полей тогда одни и те же везде. Смешивать два семейства методов на одних
 * и тех же данных — способ однажды не найти поле там, где оно есть.
 *
 * ⚠ Дата — днём, без времени: поле заведено типом `date`, и портал всё равно отрежет время.
 * Отдаём то, что он ждёт, а не полагаемся на его снисходительность.
 */
export function buildWriteScoreCall(
  entity: CrmEntity,
  id: number,
  score: number,
  completedAt: Date,
): PortalCall {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: entity.entityTypeId,
      id,
      useOriginalUfNames: 'Y',
      fields: {
        [crmFieldName(LAST_SCORE_CODE)]: score,
        [crmFieldName(LAST_SURVEY_AT_CODE)]: completedAt.toISOString().slice(0, 10),
      },
    },
  }
}

/** Каноничная форма имени для сверки: без подчёркиваний, в нижнем регистре. */
function normalize(name: string): string {
  return name.replace(/_/g, '').toLowerCase()
}
