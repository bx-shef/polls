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
  /** Машинный код из поля `error` ответа портала. Пусто — портал его не прислал. */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PortalError'
    this.code = code
  }
}

/**
 * Наш код отказа, который портал прислал БЕЗ кода: HTTP 4xx с `"error": ""` или `"0"`.
 *
 * ⚠ Свой код, а не пустота, потому что пустота значит другое: «ответа не было» — сеть, таймаут,
 * наше исключение, — и её `isRetryableRefusal` повторяет. А портал, ответивший отказом, повтором
 * не переубедишь: так приходят отказы проверки («Section at index 0 does not have title.» у
 * `crm.item.details.configuration.set`) и «Not found» (пример из «Коды ошибок» документации).
 * Сведи их к пустоте — и портал вечно ходит по кругу обустройства (issue #99, `/review` в панели PR #98).
 *
 * Ставят его разборщик ошибок SDK (`asPortalError`) и вебхук операторских команд (`scripts/-hook.ts`).
 */
export const REJECTED_CODE = 'SHEF_REJECTED'

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
 * ⚠ Отказ без кода — это не портал сказал «нет», а сеть, таймаут или наше собственное
 * исключение; такое повтор лечит чаще всего. А отказ с кодом, которого нет в списке, повтором
 * не лечится: держать ради него незавершённую работу значило бы ходить к порталу каждый час
 * вечно. Нашёл `/review` во втором круге панели PR #87.
 *
 * ⚠ Правило держится на том, что код СТАВЯТ ЧЕСТНО: сетевой сбой — без кода, отказ портала без кода —
 * `REJECTED_CODE`. Это делает `asPortalError` по статусу ответа; до issue #99 он путал оба случая.
 */
export function isRetryableRefusal(error: unknown): boolean {
  const code = refusalCode(error)
  return code === '' || RETRYABLE_CODES.includes(code)
}
