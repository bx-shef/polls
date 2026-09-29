/**
 * A portal refusal with its machine code kept apart from its prose.
 *
 * ⚠ Существует потому, что SDK их СКЛЕИВАЕТ не в ту сторону. Проверено в исходнике
 * `@bitrix24/b24jssdk` 2.2.0: `SdkError` кладёт машинный код в собственное поле `code`,
 * а `message` собирает из `formatErrorMessage`, которая возвращает РОВНО `description` —
 * человеческую фразу портала и больше ничего. `Result.getErrorMessages()` отдаёт только
 * `message`, то есть код теряется безвозвратно.
 *
 * Пока `server/b24/client.ts` бросал `new Error(getErrorMessages().join('; '))`, наверх
 * приезжала одна проза. А `safeRefusal` искал в ней машинные коды подстрокой — и не находил,
 * потому что в описаниях их нет: у `NO_AUTH_FOUND` описание «Wrong authorization data»,
 * у `PORTAL_DELETED` — «Portal was deleted». Документация Битрикс24 говорит про это прямо:
 * «Сервер авторизации возвращает код ошибки в поле `error`, а пояснение — в поле
 * `error_description`», и велит ветвиться по коду.
 *
 * Цена была не теоретической. `inbox.last_error` с PR #22 писал «код не распознан» почти
 * на любой настоящий отказ, а распознавание мёртвого гранта (PR #34) не могло сработать
 * ни разу: фича выглядела здоровой и не делала ничего. Нашла панель ревью PR #34, причём
 * тесты этого не ловили — они были собраны на самодельных `new Error('КОД: текст')`,
 * форме, которой SDK не производит.
 *
 * ⚠ Класс живёт в доменном слое, а не рядом с клиентом: по нему ветвятся чистые функции
 * (`safeRefusal`, `isDeadGrant`), а домену запрещено знать про `server/b24/`.
 */
export class PortalError extends Error {
  /**
   * Машинный код из поля `error` ответа портала — или наш: `REJECTED_CODE` (портал отказал, но кода
   * не назвал), `UNREACHABLE_CODE` (ответа портала нет). Пусто — это не отказ портала: наше исключение,
   * код SDK, портал ответил 5xx без кода.
   */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PortalError'
    this.code = code
  }
}

/**
 * Code for a refusal the portal sent without a code of its own: a 4xx body with `"error": ""` or `"0"`.
 *
 * ⚠ Свой код, а не пустота: пустота повторяется (`isRetryableRefusal`), а портал, ответивший отказом,
 * повтором не переубедишь. Так приходят отказы проверки («Section at index 0 does not have title.»
 * у `crm.item.details.configuration.set`) и «Not found» — `400 {"error": "", "error_description":
 * "Not found"}`, пример из «Коды ошибок» документации. Сведи их к пустоте — и портал вечно ходит
 * по кругу обустройства (issue #99, `/review` в панели PR #98).
 *
 * ⚠ Только когда ОТВЕТИЛ ПОРТАЛ: в теле есть ключ `error` — так документация и велит распознавать
 * ошибку, «по составу полей в теле ответа, а не по HTTP-статусу». Страница прокси или WAF с тем же
 * 403 — не отказ портала, а `UNREACHABLE_CODE` (безопасность в панели PR #106).
 *
 * Ставят его разборщик ошибок SDK (`asPortalError`) и вебхук операторских команд (`scripts/-hook.ts`).
 */
export const REJECTED_CODE = 'SHEF_REJECTED'

/**
 * Code for a call the portal never answered: no response, a truncated body, or a page that is not the portal's.
 *
 * ⚠ Свой код, а не пустота, ради того, кто читает журнал: `safeRefusal` называет его, и беда связи
 * не выглядит «портал отказал, код не распознан». Повторяется (`isRetryableRefusal`): сеть, прокси
 * при выкладке, обрыв посреди ответа лечит время. Прежде сетевой код SDK (`ECONNRESET`) доезжал
 * до `PortalError.code` как код портала, и разрыв связи отмечал разовый шаг обустройства навсегда
 * (issue #99). Программист и `/review` в панели PR #106 — за свой код вместо пустоты.
 */
export const UNREACHABLE_CODE = 'SHEF_UNREACHABLE'

/**
 * Достать машинный код отказа, если он есть.
 *
 * ⚠ Только из `PortalError`. Выковыривать `.code` из произвольного объекта нельзя:
 * туда попадёт `code` системной ошибки Node (`ECONNREFUSED`, `ETIMEDOUT`) и любой
 * чужой объект с таким полем, а на этом коде принимаются необратимые решения.
 */
export function refusalCode(error: unknown): string {
  return error instanceof PortalError ? error.code : ''
}

/**
 * Коды отказов, которые лечатся повтором: предел запросов, перегрузка, сбой на стороне портала.
 *
 * Собрано из разделов «Errors» документации `crm.type.update`, `crm.item.update`
 * и `crm.deal.userfield.update`. Всё прочее с кодом — права, тариф, проверка значения — повтор
 * не вылечит.
 */
const RETRYABLE_CODES: readonly string[] = [
  'QUERY_LIMIT_EXCEEDED',
  'OPERATION_TIME_LIMIT',
  'OVERLOAD_LIMIT',
  'INTERNAL_SERVER_ERROR',
  'ERROR_UNEXPECTED_ANSWER',
]

/**
 * Whether a refusal is worth retrying later: a known transient code, or no portal code at all.
 *
 * ⚠ Ошибка без кода — это не портал сказал «нет», а наше собственное исключение или таймаут;
 * такое повтор лечит чаще всего. Не путать с отказом портала без кода: у того свой код
 * (`REJECTED_CODE`), и его не повторяют; у беды связи — тоже свой (`UNREACHABLE_CODE`), повторяемый. А отказ с кодом, которого нет в списке, повтором
 * не лечится: держать ради него незавершённую работу значило бы ходить к порталу каждый час
 * вечно. Нашёл `/review` во втором круге панели PR #87.
 *
 * ⚠ Правило держится на том, что код СТАВЯТ ЧЕСТНО: ответа портала нет — `UNREACHABLE_CODE`, отказ
 * портала без кода — `REJECTED_CODE`. Это делает `asPortalError` по источнику ошибки и телу ответа;
 * до issue #99 он путал оба случая.
 */
export function isRetryableRefusal(error: unknown): boolean {
  const code = refusalCode(error)
  return code === '' || code === UNREACHABLE_CODE || RETRYABLE_CODES.includes(code)
}
