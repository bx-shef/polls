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
   * The machine code: the portal's own from its `error` field, or ours — `REJECTED_CODE` (the portal
   * refused without naming a code), `UNREACHABLE_CODE` (no portal answer).
   *
   * Вердикт портала — код, который он назвал сам, или `REJECTED_CODE`: по нему решают «повторять или нет».
   * `UNREACHABLE_CODE` и пустота — не вердикт, а то, что лечит повтор. Пусто — это наше исключение, наш
   * таймаут, код SDK, ответ портала без кода с 5xx, 408 или 429 и незнакомый код с ними же.
   */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PortalError'
    this.code = code
  }
}

/**
 * Code for a refusal the portal sent without naming a code: `"error": ""` or `"0"` in a 4xx answer other
 * than 408 and 429, or `"0"` in a 2xx one — always in the documented body form (`refusalCodeIn`).
 *
 * ⚠ Свой код, а не пустота: пустота повторяется (`isRetryableRefusal`), а портал, ответивший отказом,
 * повтором не переубедишь. Так приходят отказы проверки («Section at index 0 does not have title.»
 * у `crm.item.details.configuration.set`) и «Not found» — `400 {"error": "", "error_description":
 * "Not found"}`, пример из «Коды ошибок» документации. Сведи их к пустоте — и портал вечно ходит
 * по кругу обустройства (issue #99, `/review` в панели PR #98).
 *
 * ⚠ Только когда ОТВЕТИЛ ПОРТАЛ — тело в документированной форме (`refusalCodeIn`): так документация
 * и велит распознавать ошибку, «по составу полей в теле ответа, а не по HTTP-статусу». Страница прокси
 * или WAF с тем же 403, чужой JSON вроде `{"error": true}` и проза вместо кода — не отказ портала,
 * а `UNREACHABLE_CODE` (безопасность в панели PR #106).
 *
 * Ставят его разборщик ошибок SDK (`asPortalError` — и для брошенного, и для отданного результатом)
 * и вебхук операторских команд (`scripts/-hook.ts`).
 */
export const REJECTED_CODE = 'SHEF_REJECTED'

/**
 * Code for a call that got no portal answer: no response, a truncated body, a body that is not a portal
 * refusal (a page, foreign JSON, prose or a foreign code for a code), a 2xx answer without `result`
 * (with `time` in it), `invalid_grant` in an answer to a call, or no fresh token — a refresh refused
 * for any reason but a dead grant.
 *
 * ⚠ Свой код, а не пустота, ради того, кто читает журнал: `safeRefusal` называет его, и беда связи
 * не выглядит «портал отказал, код не распознан». Повторяется (`isRetryableRefusal`): сеть, прокси
 * при выкладке, обрыв посреди ответа лечит время. Прежде сетевой код SDK (`ECONNRESET`) доезжал
 * до `PortalError.code` как код портала, и разрыв связи отмечал разовый шаг обустройства навсегда
 * (issue #99). Программист и `/review` в панели PR #106 — за свой код вместо пустоты.
 *
 * Наш собственный таймаут (`withTimeout` в `server/b24/client.ts`) этим кодом не помечается: кода у него
 * нет, повторяется он так же, а в журнале называется своими словами — «портал не ответил вовремя».
 */
export const UNREACHABLE_CODE = 'SHEF_UNREACHABLE'

/**
 * Code for a list that did not end within our page cap: whatever was read is not the whole list.
 *
 * ⚠ Отказ, а не неполный список: по неполному поиск перед созданием завёл бы второй смарт-процесс,
 * номер версии мог оказаться занятым, перенос написал бы дубль. Предел — страховка от кривого `next`,
 * а не ожидаемый размер, и с #110 он достижим и на пути через SDK: прежде там листание вставало после
 * первой страницы (вебхук операторских команд листал всегда). Тем же кодом отказывает поиск наших
 * смарт-процессов и полей (`provision.ts`; `listAllTypes` зовут и операторские команды), когда
 * листание не продвигается: портал говорит «есть ещё», а смещение не растёт.
 *
 * Повтором не лечится (`isRetryableRefusal`): сам список не укоротится, а кривой `next` — не беда связи.
 * Поэтому разовый шаг миграции его не повторяет; а упав на критическом пути установки, портал уходит
 * в `degraded`, и долечивание возвращается раз в час, как с любым отказом там (#112, п. 4).
 *
 * Ставят его листающие циклы операторских команд (`server/b24/write-templates.ts`, `publish-templates.ts`)
 * и обустройства (`provision.ts`). Константа здесь, рядом с соседями, а не у тех, кто бросает: её называет
 * `safeRefusal`, а домену импортировать `server/b24` нельзя (`/review` во втором круге PR #113).
 */
export const LIST_TRUNCATED_CODE = 'SHEF_LIST_TRUNCATED'

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
 * Whether a code is one a portal can name: the documented shape, without the prefixes of the SDK, axios or ours.
 *
 * Форма — из документации: код «состоит из цифр, латинских букв и знака подчеркивания» («Коды ошибок»).
 * Своих кодов портал назвать не может: `SHEF_*` в теле — чужая строка, а не наш диагноз; `JSSDK_*`
 * и `ERR_*` — коды SDK и axios (безопасность в панели PR #106).
 *
 * ⚠ Код сети (`ECONNRESET`) и два кода SDK без префикса (`NETWORK_ERROR`, `REQUEST_TIMEOUT`) форму
 * проходят. Решать по ним здесь нельзя, и не приходится: SDK создаёт их только вместе с ошибкой axios
 * за спиной, а такую разбирают по телу ответа (`fromAnswer` в `server/b24/client.ts`), до этой проверки
 * не доходя (`/review` в закрывающем круге панели PR #106).
 */
export function isPortalCode(code: string): boolean {
  return /^\w+$/.test(code) && !/^(?:JSSDK|ERR|SHEF)_/.test(code)
}

/**
 * The code a response body refuses with: the portal's own, `''` for a refusal without a code (`""` or `"0"`),
 * or `null` when the body is not a portal refusal at all.
 *
 * ⚠ Отказ портала — ровно документированная форма: поля `error` и `error_description` строками («Коды
 * ошибок»: «Есть поля `error` и `error_description`» — «Вызов не выполнен») или объект REST v3 со строкой
 * `code`. Всё прочее с ключом `error` — не ответ портала: `{"error": true}`, `{"error": "Forbidden"}` без
 * описания от шлюза или WAF, проза вместо кода, код SDK или наш в чужом теле. Выдать такое за
 * окончательный отказ значило бы отпустить шаг навсегда — тот же дефект, что #99. Нашли все семеро
 * в закрывающем круге панели PR #106: форма `^\w+$` одна отсекала только прозу с пробелом.
 *
 * ⚠ Пустой код — тоже отказ портала: документация велит «проверять в ответе наличие ключа `error`,
 * а не его значение», и `400 {"error": "", "error_description": "Not found"}` — её же пример. `"0"`
 * портал прислал 29.09 на правку закрытого дела.
 *
 * Общая для вызовов через SDK (`server/b24/client.ts`) и вебхука операторских команд (`scripts/-hook.ts`):
 * двум путям к порталу расходиться нельзя.
 */
export function refusalCodeIn(body: unknown): string | null {
  const named = namedIn(body)
  if (named === null) return null
  if (named === '' || named === '0') return ''
  return isPortalCode(named) ? named : null
}

/** The string a refusal body names in `error`: `error` beside `error_description`, or a REST v3 `error.code`. */
function namedIn(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const { error, error_description: description } = body as { error?: unknown, error_description?: unknown }
  if (typeof error === 'string') return typeof description === 'string' ? error : null
  if (error === null || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
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
 * Whether a refusal is worth retrying later: a known transient code, no portal answer (`UNREACHABLE_CODE`),
 * or no code at all.
 *
 * ⚠ Ошибка без кода — это не портал сказал «нет», а наше исключение, наш таймаут, код SDK или ответ
 * портала без кода с 5xx, 408 или 429; такое повтор лечит чаще всего. Не путать с отказом портала
 * без кода: у того свой код (`REJECTED_CODE`), и его не повторяют; у беды связи — тоже свой
 * (`UNREACHABLE_CODE`), повторяемый. А отказ с кодом, которого нет в списке, повтором не лечится:
 * держать ради него незавершённую работу значило бы ходить к порталу каждый час вечно. Нашёл `/review`
 * во втором круге панели PR #87. Обратная сторона — повтор без счётчика попыток: беда связи, которая
 * не проходит, повторяется раз в час без конца; это принятый риск (`docs/PROCESS.md`, issue #112, п. 4).
 *
 * ⚠ Правило держится на том, что код СТАВЯТ ЧЕСТНО: ответа портала нет — `UNREACHABLE_CODE`, отказ
 * портала без кода — `REJECTED_CODE`. Это делает `asPortalError` по источнику ошибки и телу ответа;
 * до issue #99 он путал оба случая.
 */
export function isRetryableRefusal(error: unknown): boolean {
  return isRetryableCode(refusalCode(error))
}

/** Whether a refusal code is worth retrying: the rule of `isRetryableRefusal`, for a code at hand. */
export function isRetryableCode(code: string): boolean {
  return code === '' || code === UNREACHABLE_CODE || RETRYABLE_CODES.includes(code)
}
