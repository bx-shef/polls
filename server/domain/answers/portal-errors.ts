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
 * и `crm.timeline.comment.add` в документации Битрикс24.
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
] as const

/** Что пишем, когда код не распознан. Фиксированная строка — в ней нет ничего чужого. */
export const UNKNOWN_REFUSAL = 'портал отказал, код не распознан'

/** Наш собственный текст таймаута из `server/b24/client.ts`: он безопасен, в нём только имя метода. */
const TIMEOUT_MARK = 'портал не ответил за'

/**
 * Свести отказ портала к безопасной строке.
 *
 * ⚠ Важно, что функция ВЫБИРАЕТ из своего списка, а не фильтрует чужую строку. Фильтр
 * рано или поздно пропускает: достаточно, чтобы респондент набрал ответ заглавными буквами
 * через подчёркивания, и «вырезание всего, кроме кодов» вынесло бы его текст наружу.
 * Здесь же результат — всегда одна из констант этого файла.
 */
export function safeRefusal(error: unknown): string {
  const raw = typeof error === 'string' ? error : String((error as Error | undefined)?.message ?? '')
  if (raw === '') return UNKNOWN_REFUSAL

  const hit = KNOWN_CODES.find(code => raw.includes(code))
  if (hit !== undefined) return hit

  // Таймаут — наша собственная формулировка, и метод в ней назвать полезно.
  if (raw.includes(TIMEOUT_MARK)) return 'портал не ответил вовремя'

  return UNKNOWN_REFUSAL
}
