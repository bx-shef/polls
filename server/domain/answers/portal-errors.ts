import { PortalError, REJECTED_CODE, UNREACHABLE_CODE, refusalCode } from '../portals/portal-error'

/**
 * Turns a portal refusal into something safe to write down.
 *
 * ⚠ Существует ровно потому, что `error.message` от портала писать в журнал НЕЛЬЗЯ. Казалось бы,
 * можно: SDK пропускает ошибку через своё вырезание секретов. Но вырезает он по ИМЕНИ ключа
 * (`token`, `password`, `secret`) и только в структурированных полях. Собственная документация
 * SDK говорит об этом прямо:
 *
 * > What redaction does *not* cover is portal prose: a message that quotes a submitted value
 * > stays as the portal wrote it.
 *
 * А цитировать присланное значение Битрикс24 любит — это обычная форма ошибки валидации
 * строкового поля. В двух наших вызовах присланное значение это ОТВЕТ КЛИЕНТА: `ANSWERS`
 * в `crm.item.update` и `COMMENT` в `crm.timeline.comment.add`. То есть отказ портала по
 * длине поля принёс бы текст ответа прямо в журнал и в колонку `inbox.last_error` — при
 * инварианте «не логировать текст ответа клиента, даже в отладке, даже временно».
 * Нашла панель ревью PR #22.
 *
 * Поэтому наружу отдаётся не текст портала, а НАШ собственный: либо распознанный код ошибки,
 * либо одна фиксированная строка. Ничего, что мог набрать респондент, сквозь эту функцию
 * не проходит по построению — не «маловероятно», а невозможно.
 */

/**
 * Коды отказов, которые мы умеем называть.
 *
 * Список нужен не ради полноты, а ради различимости: по нему видно, чинится ли беда правами,
 * переустановкой, ожиданием или ничем. Всё, чего здесь нет, схлопывается в одну строку —
 * это дешевле, чем пропустить наружу чужую прозу ради диагностики одного редкого случая.
 *
 * Собрано из разделов «Errors» методов `crm.item.update`, `crm.item.get`
 * и `crm.timeline.comment.add` в документации Битрикс24, а с issue #84 (п. 14 и 6) —
 * ещё `crm.activity.todo.update` и `crm.activity.layout.blocks.set`.
 *
 * ⚠ `CAN_NOT_UPDATE_COMPLETED_TODO` записан по документации, но портал 29.09 на закрытое дело
 * ответил кодом `"0"` — решения на этом коде не принимаются (`FoundActivity.completed`).
 */
const KNOWN_CODES = [
  'ACCESS_DENIED',
  'OWNER_NOT_FOUND',
  'NOT_FOUND',
  'INVALID_ARG_VALUE',
  'CRM_FIELD_ERROR_VALUE_NOT_VALID',
  'UPDATE_DYNAMIC_ITEM_RESTRICTED',
  'allowed_only_intranet_user',
  'QUERY_LIMIT_EXCEEDED',
  'OPERATION_TIME_LIMIT',
  'OVERLOAD_LIMIT',
  'INTERNAL_SERVER_ERROR',
  'ERROR_UNEXPECTED_ANSWER',
  'ERROR_BATCH_METHOD_NOT_ALLOWED',
  'NO_AUTH_FOUND',
  'INVALID_REQUEST',
  'INVALID_CREDENTIALS',
  'ERROR_MANIFEST_IS_NOT_AVAILABLE',
  'insufficient_scope',
  'expired_token',
  'user_access_error',
  'PORTAL_DELETED',
  'CAN_NOT_UPDATE_COMPLETED_TODO',
  'WRONG_DATETIME_FORMAT',
  'ERROR_WRONG_CONTEXT',
  'UNSUITABLE_ACTIVITY_TYPE_ERROR',
  'TOO_MANY_ITEMS',
  'KEY_CONTAIN_WRONG_SYMBOLS',
  'FIELD_IS_REQUIRED',
  'FIELD_IS_REDUNDANT',
  'WRONG_FIELD_VALUE',
  'ENUM_FIELD',
] as const

/**
 * Наши собственные коды — не портала.
 *
 * ⚠ Заведены отдельным списком, потому что `KNOWN_CODES` собран из разделов «Errors»
 * документации Битрикс24, и подмешивать туда своё значило бы врать о происхождении.
 * Но проходить через `safeRefusal` они обязаны: без этого специально написанный диагноз
 * схлопывался в «код не распознан» и доезжал до оператора неотличимым от сетевой беды —
 * ровно то, ради чего его и заводили. Дефект прожил от PR #47 до находки code-review
 * в PR #50: `SHEF_CREATED_NOTHING` бросался с кодом и ни разу не был назван.
 */
const OWN_CODES = [
  /** Портал принял `crm.item.add` и ничего не создал. */
  'SHEF_CREATED_NOTHING',
  /** Портал принял `crm.item.update` и ничего не изменил. */
  'SHEF_UPDATED_NOTHING',
  /** Списочный метод не дочитан до конца: продолжать на неполных данных нельзя. */
  'SHEF_LIST_TRUNCATED',
  /** Портал отказал без кода (`"error": ""` или `"0"`), повтор не лечит. */
  REJECTED_CODE,
  /** Ответа портала нет — сеть, обрыв посреди ответа, не тело портала, ответ без `result`, токен не продлён. */
  UNREACHABLE_CODE,
] as const

/** Что пишем, когда код не распознан. Фиксированная строка — в ней нет ничего чужого. */
export const UNKNOWN_REFUSAL = 'портал отказал, код не распознан'

/**
 * What we write for a `PortalError` without a code: not the portal's verdict.
 *
 * ⚠ Отдельно от `UNKNOWN_REFUSAL`: пустой код с issue #99 — это наше исключение, код SDK или ответ
 * портала без кода с 5xx, 408 или 429, и «портал отказал» про него неправда. Ровно против такого
 * ложного диагноза и заведён `UNREACHABLE_CODE` (технический директор в закрывающем круге панели
 * PR #106; было issue #108, п. 7). Исключение, которое не прошло разбор `asPortalError` и потому
 * не `PortalError`, по-прежнему называется `UNKNOWN_REFUSAL`: его происхождения мы здесь не знаем.
 */
export const CODELESS_REFUSAL = 'ошибка без кода портала'

/** Наш собственный текст таймаута из `server/b24/client.ts`: он безопасен, в нём только имя метода. */
const TIMEOUT_MARK = 'портал не ответил за'

/** Whether a code is one we can name: a documented portal code or one of ours. */
function isNamedCode(code: string): boolean {
  return (KNOWN_CODES as readonly string[]).includes(code) || (OWN_CODES as readonly string[]).includes(code)
}

/**
 * Свести отказ портала к безопасной строке.
 *
 * ⚠ Важно, что функция ВЫБИРАЕТ из своего списка, а не фильтрует чужую строку. Фильтр
 * рано или поздно пропускает: достаточно, чтобы респондент набрал ответ заглавными буквами
 * через подчёркивания, и «вырезание всего, кроме кодов» вынесло бы его текст наружу.
 * Здесь же результат — всегда одна из констант этого файла.
 */
export function safeRefusal(error: unknown): string {
  // ⚠ Сначала СТРУКТУРНЫЙ код, и только он имеет силу. Портал присылает код в поле `error`,
  // а пояснение — в `error_description`; документация Битрикс24 велит ветвиться по коду.
  // `server/b24/client.ts` доносит его сюда в `PortalError.code`.
  const code = refusalCode(error)
  if (code !== '') return isNamedCode(code) ? code : UNKNOWN_REFUSAL

  const raw = typeof error === 'string' ? error : String((error as Error | undefined)?.message ?? '')

  // Таймаут — наша собственная формулировка, и метод в ней назвать полезно.
  if (raw.includes(TIMEOUT_MARK)) return 'портал не ответил вовремя'

  // ⚠ Поиска кодов подстрокой здесь БОЛЬШЕ НЕТ, и это исправление двух дефектов сразу.
  //
  // Первый: он не работал. Искать машинный код в `message` бессмысленно — там лежит одно
  // описание портала («Wrong authorization data», «Доступ запрещен»), кода в нём нет.
  // То есть почти любой настоящий отказ схлопывался в «код не распознан» с PR #22.
  //
  // Второй: он был управляем снаружи. `KNOWN_CODES.find(code => raw.includes(code))`
  // возвращал первый код ПО ПОРЯДКУ В МАССИВЕ, найденный где угодно в строке, — а Битрикс24
  // цитирует присланное значение в ошибке валидации, и присланное значение у нас это ответ
  // клиента. Респондент, набравший в анкете `expired_token`, выбирал бы код за нас: на этом
  // коде принимаются необратимые решения (`server/domain/portals/lifecycle.ts`).
  // Обе находки — панель ревью PR #34.
  //
  // Осталось без кода — значит перед нами не вердикт портала: наше исключение, код SDK или ответ
  // портала без кода с 5xx, 408 или 429. Беда связи сюда не доезжает — у неё свой код
  // (`UNREACHABLE_CODE`, issue #99). Называть это чужим кодом нельзя, а «портал отказал» — неправда.
  return error instanceof PortalError ? CODELESS_REFUSAL : UNKNOWN_REFUSAL
}
