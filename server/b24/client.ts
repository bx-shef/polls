import { AjaxError, B24OAuth, RefreshTokenError } from '@bitrix24/b24jssdk'
import { b24ClientId, b24ClientSecret } from '../utils/env'
import type { PortalCaller, RestCall } from './provision'
import { safeRefusal } from '../domain/answers/portal-errors'
import { isDeadGrantCode } from '../domain/portals/lifecycle'
import { isPortalCode, isRetryableCode, PortalError, refusalCodeIn, REJECTED_CODE, UNREACHABLE_CODE } from '../domain/portals/portal-error'
import { logger } from '../utils/logger'

/**
 * A portal-bound REST caller backed by the official SDK.
 *
 * SDK берётся не ради удобства, а ради `RestrictionManager`: в нём leaky-bucket и адаптивный
 * backoff под лимиты портала. Свой троттлинг писать запрещено инвариантом — он обязательно
 * разойдётся с настоящими лимитами, и разойдётся молча.
 *
 * ⚠ Встроенный ретрай ВЫКЛЮЧЕН (`maxRetries: 1`). Вызовы создания не идемпотентны:
 * `crm.type.add`, повторённый транспортом после таймаута, создаёт второй смарт-процесс —
 * при лимите 150 на весь портал. Повторяет задачу очередь, а не транспорт.
 *
 * ⚠ Домен портала здесь НЕ проверяется. `makePortalCall` доверяет `auth.domain` как есть
 * и строит из него `clientEndpoint`, то есть адрес, куда уедет токен. Обеспечивают это
 * вызывающие, и каждый по-своему:
 *
 * - `server/api/install.post.ts` — домен приходит из события установки и проходит
 *   `isPortalDomain()` в `server/domain/portals/grant.ts` (аллоулист `*.bitrix24.<зона>`);
 * - `server/api/portal/-session.ts` — домен берётся из НАШЕЙ записи в БД по `member_id`,
 *   то есть из того, что уже проверили при установке, а не из запроса.
 *
 * Второй случай и есть правило для всех следующих: домен либо из аллоулиста, либо из своей
 * базы. Взять его из тела запроса значит отправить наш токен туда, куда укажет обращающийся.
 *
 * ⚠ Адрес сервера авторизации (`serverEndpoint`, третий параметр `makePortalCall`) — туда уходят
 * `client_secret` и `refresh_token`. Боевые вызывающие его НЕ передают и получают константу
 * `SERVER_ENDPOINT`; передают только тесты — свой локальный сервер. Взять адрес откуда-то ещё значит
 * отправить секрет приложения туда, куда укажут (`/review` в закрывающем круге панели PR #106).
 */

/** Адрес сервера авторизации. Тот же, что у обмена токена, и он же в примерах самого SDK. */
const SERVER_ENDPOINT = 'https://oauth.bitrix.info/rest/'

/**
 * Предел одного вызова портала.
 *
 * Тот же приём, что в `server/b24/oauth.ts`: зависший запрос не должен превращаться
 * в зависший обработчик. Транспорт SDK своего таймаута не обещает, а обустройство делает
 * полтора десятка вызовов подряд — без предохранителя одна не отвечающая сеть держала бы
 * HTTP-запрос установки до таймаута прокси. Двадцать секунд с запасом покрывают
 * и троттлинг, и медленный портал.
 */
const CALL_TIMEOUT_MS = 20_000

/**
 * What the log says about a batch command the SDK counted a success without a result.
 *
 * Фиксированная строка: кода у такой команды нет — SDK его не признал (`"error": ""`; было issue #108, п. 2).
 */
const EMPTY_COMMAND = 'портал не вернул результата команды'

/** The SDK's own code for a portal body whose `error` is `"0"` (`AjaxResult`, `parse-error-payload.mjs`). */
const CODELESS_IN_BODY = 'JSSDK_RESPONSE_ERROR'

/**
 * Codes of the authorization server we may write to the log as they are.
 *
 * ⚠ Список, а не форма: журнал ВЫБИРАЕТ из своего набора, а не фильтрует чужую строку (шапка
 * `server/domain/answers/portal-errors.ts`). Коды — из документации сервера авторизации («Коды
 * ошибок», «Автоматическое продление токенов OAuth 2.0»); `wrong_client` сервер прислал 29.09
 * на пустую пару ключей. `/code-review` в закрывающем круге панели PR #106.
 */
const AUTH_CODES: readonly string[] = [
  'invalid_request',
  'invalid_client',
  'wrong_client',
  'invalid_scope',
  'insufficient_scope',
  'invalid_grant',
  'PAYMENT_REQUIRED',
]

/** A Node or axios transport code: `ECONNRESET`, `ETIMEDOUT`, `ERR_BAD_RESPONSE` — ours, not the server's text. */
const TRANSPORT_CODE = /^(?:E[A-Z0-9_]{2,31}|ERR_[A-Z_]{2,40})$/

export interface PortalAuth {
  memberId: string
  domain: string
  accessToken: string
  refreshToken: string
  applicationToken: string
  /** Секунды до истечения `accessToken` на момент получения. */
  expiresIn: number
  scope: string[]
}

/**
 * Собрать вызов метода портала — одиночный и пакетный.
 *
 * `onRefresh` вызывается, когда SDK сам обновил токены: сохранять их обязательно, иначе
 * следующий запуск пойдёт со старой парой, а она после обмена мертва. Персист — только
 * UPDATE, чтобы операция была идемпотентной при нескольких репликах.
 *
 * ⚠ Оба вызова возвращаются ОДНИМ объектом поверх ОДНОГО клиента. Второй клиент ради
 * пакета означал бы второй `RestrictionManager` на тот же портал — два троттлинга,
 * каждый со своей половиной картины лимитов, и оба неверные.
 *
 * `serverEndpoint` подменяют только тесты: продление токена идёт на их локальный сервер, а не наружу.
 * Прежде тесты продления собирали клиент SDK руками — и проверяли не нашу обвязку, а свою копию
 * её настроек (тестировщик во втором круге панели PR #106).
 */
export function makePortalCall(
  auth: PortalAuth,
  onRefresh?: (next: { accessToken: string, refreshToken: string, expiresIn: number }) => Promise<void>,
  serverEndpoint = SERVER_ENDPOINT,
): PortalCaller {
  // ⚠ Туда уходят `client_secret` и `refresh_token`: кроме константы — только свой компьютер, тесты.
  // Граница держится кодом, а не абзацем в шапке (безопасность и `/review` в закрывающем круге).
  if (serverEndpoint !== SERVER_ENDPOINT && !/^https:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/rest\/$/.test(serverEndpoint)) {
    throw new Error('makePortalCall: адрес сервера авторизации — только боевой или локальный')
  }
  const client = new B24OAuth(
    {
      applicationToken: auth.applicationToken,
      // Идентификатор пользователя SDK использует только для служебных ключей и не шлёт
      // в вызовы. Своего у нас нет: в событии установки его не бывает, а хранить ради
      // одной строки — лишнее поле в схеме.
      userId: 0,
      memberId: auth.memberId,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expires: Math.floor(Date.now() / 1000) + auth.expiresIn,
      expiresIn: auth.expiresIn,
      scope: auth.scope.join(','),
      domain: auth.domain,
      clientEndpoint: `https://${auth.domain}/rest/`,
      serverEndpoint,
      // Тариф портала. Ни вызовы, ни троттлинг, ни лицензия его не читают — при первом
      // обновлении токена SDK перезапишет значение настоящим, пришедшим с портала.
      // Ставим `'L'` (local), а не `'F'` (free): заявлять чужой тариф, которого может
      // и не быть, — врать в поле, которое нам всё равно не принадлежит.
      status: 'L',
    },
    { clientId: b24ClientId(), clientSecret: b24ClientSecret() },
    {
      restrictionParams: {
        // ⚠ Одна попытка, без повторов: см. шапку файла.
        maxRetries: 1,
        // Избыточно при `maxRetries: 1` — ветка повтора при нём недостижима. Стоит явно,
        // чтобы поднятие числа попыток не включило заодно и повтор по сетевой ошибке:
        // именно он и создаёт второй смарт-процесс после таймаута.
        retryOnNetworkError: false,
      },
    },
  )

  if (onRefresh !== undefined) {
    client.setCallbackRefreshAuth(async ({ b24OAuthParams }) => {
      await onRefresh({
        accessToken: b24OAuthParams.accessToken,
        refreshToken: b24OAuthParams.refreshToken,
        expiresIn: Number(b24OAuthParams.expiresIn) || 3600,
      })
    })
  }

  const call: RestCall = async (method, params = {}) => {
    // ⚠ SDK обычно БРОСАЕТ отказ портала, а не возвращает его результатом. Проверено зондом против
    // настоящего SDK 2.2.0: ответ `400 {"error":"ACCESS_DENIED"}` приезжает исключением
    // `AjaxError`, и для такого ответа ветка `!response.isSuccess` не достигается. Первая редакция
    // строила `PortalError` только в этой ветке — то есть почти никогда, и весь разбор кодов снова
    // работал вслепую. Нашла повторная панель ревью PR #34; первая нашла предыдущий слой
    // той же ошибки. Результатом SDK отдаёт отказ в двух случаях: код из его списка «мягких»
    // (`ERROR_ENTITY_NOT_FOUND` и коды REST v3) и ответ 2xx с ошибкой в теле.
    let response
    try {
      response = await withTimeout(client.actions.v2.call.make({ method, params }), method)
    }
    catch (error) {
      throw asPortalError(error)
    }
    if (!response.isSuccess) {
      // Отказ результатом, а не исключением. Разбор тот же (`asPortalError`): мягкий код с ответа
      // 4xx несёт за спиной ошибку axios, ошибка из тела 2xx — нет. Ошибка в наборе есть всегда:
      // `isSuccess` у SDK — ровно «набор ошибок пуст».
      const [refusal] = response.getErrors()
      throw asPortalError(refusal)
    }
    const data = response.getData()
    // ⚠ Успех — это ответ С полем `result`, каким бы ни было его значение («Коды ошибок»: «Есть поле
    // `result`, а поле `result.result_error` пустое или отсутствует» — «Вызов выполнен»). SDK считает
    // успехом и ответ 2xx без него — страницу с полем `time`, пустой `"error": ""` рядом с `time`, —
    // и отдаёт `{ result: undefined }`. Вызывающий прочитал бы это как «ничего нет»: пустой список
    // типов перед созданием — второй смарт-процесс. Программист в панели PR #106. Именно
    // `=== undefined`, а не `!result`: `false` от `user.admin` не администратору — успех (тестировщик).
    if (data?.result === undefined) throw new PortalError(UNREACHABLE_CODE, `${method}: в ответе портала нет результата`)
    return data
  }

  /**
   * Пакет команд одним обращением.
   *
   * ⚠ `isHaltOnError: false` — то есть `halt: 0` в протоколе. Пакет заведён под чтение
   * нескольких связанных сущностей, и там остановка на первой упавшей команде означает
   * потерю уже полученного: у сделки может не быть контакта, и это не повод не показать
   * ни компанию, ни проект. Поведение подтверждено на живом портале 23.09: упавшая
   * команда приезжает в `result_error`, остальные — в `result`, и пакет успешен.
   *
   * ⚠ Наружу отдаём ТОЛЬКО успешные команды. Так их отбирает и сам SDK
   * (`_extractBatchSimpleData`): у него в данных оказываются лишь те ключи, по которым
   * пришёл результат. Отсутствие ключа — единственный признак отказа, на который вызывающий
   * может опереться, и он же самый честный: «данных нет» вместо подделки пустым объектом.
   * Одну дыру SDK оставляет — команду с пустым кодом отказа (`"error": ""`) он считает успехом
   * и отдаёт её ключ с `undefined`. Такой ключ выбрасываем сами и пишем в журнал (было issue #108,
   * п. 2; `/review` и технический директор в закрывающем круге панели PR #106).
   *
   * ⚠ Отказ отдельной команды пишется в журнал ЗДЕСЬ, а не у вызывающего. Иначе он
   * не пишется нигде: вызывающий видит просто отсутствующий ключ и не отличает
   * «у сделки нет компании» от «портал отказал в правах». В журнал уходит имя команды
   * и отказ через `safeRefusal` — ни параметров, ни данных клиента. Код команды приходит
   * из тела портала, и мимо `safeRefusal` в журнал уезжала бы любая строка, какую туда
   * положат (безопасность в панели PR #106).
   *
   * ⚠ Отказ ВСЕГО пакета — не отказ команды, и он бросается, как у одиночного вызова. Исключением
   * SDK его и бросает, а результатом отдаёт в тех же двух случаях, что у `call`: мягкий код и ответ
   * 2xx с ошибкой в теле. Такой отказ SDK кладёт в набор под своим ключом (`base-error`), а не под
   * именем команды — по этому его и узнаём: ключа, которого нет среди наших команд, у отказа команды
   * не бывает. Решаем по нашим именам, а не по литералу SDK (безопасность в закрывающем круге);
   * поэтому имя команды `base-error` занимать нельзя.
   * Прежде такой отказ писался в журнал «командой» `base-error`, а наружу уходил пустой пакет:
   * выпуск ссылки выдавал отказ портала за «у сделки ничего не заполнено». Нашёл `/review`
   * в панели PR #106.
   */
  const batch: PortalCaller['batch'] = async (calls) => {
    let response
    try {
      response = await withTimeout(
        client.actions.v2.batch.make<unknown>({ calls, options: { isHaltOnError: false } }),
        'batch',
      )
    }
    catch (error) {
      throw asPortalError(error)
    }

    if (!response.isSuccess) {
      // ⚠ `getErrorsByKey`, а не `getErrors`: второй выбрасывает ключи, и в журнале осталось бы
      // «что-то не отработало» без ответа на вопрос ЧТО. Ключ — имя команды, как мы её назвали.
      // Разбор тот же, что у одиночного вызова: отказ команды SDK отдаёт ошибкой, разобранной
      // из её записи в `result_error`, — с кодом портала и без ошибки axios за спиной.
      const refusals = response.getErrorsByKey()
      const whole = Object.keys(refusals).find(key => !Object.hasOwn(calls, key))
      if (whole !== undefined) throw asPortalError(refusals[whole])
      for (const [name, error] of Object.entries(refusals)) {
        logger.warn({ command: name, reason: safeRefusal(asPortalError(error)) }, 'команда пакета не отработала')
      }
    }

    const answered: Record<string, unknown> = {}
    for (const [name, value] of Object.entries((response.getData() ?? {}) as Record<string, unknown>)) {
      if (value === undefined) logger.warn({ command: name, reason: EMPTY_COMMAND }, 'команда пакета не отработала')
      else answered[name] = value
    }
    return answered
  }

  return { call, batch }
}

/**
 * Turn what the SDK threw — or returned in a result — into a `PortalError` with a machine code.
 *
 * ⚠ РЕШАЕТ ИСТОЧНИК ОШИБКИ И ТЕЛО ОТВЕТА, а не имя кода и не статус (issue #99). Документация
 * велит распознавать ошибку «по составу полей в теле ответа, а не по HTTP-статусу» («Коды ошибок»).
 * Источников четыре, и у каждого своё правило:
 *
 * | Источник | Как узнать | Правило |
 * |---|---|---|
 * | Ответ на вызов | `originalError` — ошибка axios | `fromAnswer`: тело (`refusalCodeIn`), затем статус |
 * | Продление токена | `originalError` — `RefreshTokenError` | `fromTokenRefresh`: мёртвый грант или ответа нет |
 * | Ошибка из тела без сети за спиной | `AjaxError` без ошибки axios: тело 2xx, команда пакета | `fromResult`: код портала; `"0"` — `SHEF_REJECTED` |
 * | Наше исключение, код SDK | всё прочее | `fromResult`: пусто, это не вердикт портала |
 *
 * Мягкий код с ответа 4xx (`ERROR_ENTITY_NOT_FOUND`) SDK отдаёт результатом, а не исключением, но это
 * та же ошибка с axios за спиной — первая строка таблицы.
 *
 * Прежде всё решалось по префиксу кода — и в обе стороны неверно. Сетевой код SDK (`ECONNRESET`)
 * доезжал до `PortalError.code` как код портала, и разрыв связи на разовом шаге обустройства отмечал
 * ревизию навсегда. А отказ проверки с пустым кодом SDK сводит к `ERR_BAD_REQUEST`, и он считался
 * повторимым: портал проходил обустройство целиком каждый час вечно. Нашёл `/review` в панели PR #98.
 * Первая редакция исправления решала по статусу — и панель PR #106 нашла, что статус не прямой
 * признак: страница прокси с 403 выходила «отказом портала», а обрыв посреди сжатого тела приходит
 * уже с настоящим статусом и снова становился кодом портала.
 *
 * ⚠ Внешний и внутренний код не взаимозаменяемы — обратный порядок я однажды уже написал, и его
 * поймал `tests/unit/portal-call-errors.test.ts` в первом же прогоне. У отказа метода снаружи код
 * портала (`ACCESS_DENIED`), а внутри код axios (`ERR_BAD_REQUEST`); у мёртвого гранта снаружи код
 * SDK (`JSSDK_UNKNOWN_ERROR`), а настоящий внутри, в `RefreshTokenError`. Код читается там, где его
 * положил источник.
 *
 * ⚠ Наш собственный таймаут (`withTimeout`) сюда тоже попадает. У него кода нет, и это
 * правильно: он не отказ портала, а наше решение не ждать дольше. Повторяется, а в журнале
 * называется своими словами (`safeRefusal`).
 */
export function asPortalError(error: unknown): PortalError {
  if (!(error instanceof Error)) return new PortalError('', String(error))
  const original = (error as { originalError?: unknown }).originalError
  if (isAxiosError(original)) return fromAnswer(original, error.message)
  if (original instanceof RefreshTokenError) return fromTokenRefresh(codeOf(original), error.message)
  return fromResult(error)
}

/**
 * Classify a call that went over the network: by the response body, then by the status.
 *
 * - ответа нет, или тело — не отказ портала (`refusalCodeIn`: страница прокси или WAF, оборванное тело,
 *   чужой JSON, проза вместо кода) — `UNREACHABLE_CODE`: портал не отказывал, повтор лечит;
 * - портал отказал без кода — `REJECTED_CODE` на 4xx, кроме 408 и 429; 5xx, 408 и 429 без кода лечит время;
 * - портал назвал код — он и решает, но незнакомый код на 5xx, 408 и 429 повторяется.
 *
 * ⚠ Код читается из ТЕЛА ответа, а не у ошибки SDK: SDK подставляет вместо пустого и `"0"` код axios
 * и пропускает прозу как код, а решать нам надо по документированной форме.
 *
 * ⚠ Незнакомый код на 5xx, 408 и 429 — повтор. Документация различает системные ошибки и ошибки метода
 * статусом («Системные ошибки авторизации и доступа приходят со статусом `401`, ошибки метода — с `400`
 * или `403`»), а все системные коды, какие она называет с 5xx и 429, велит повторять
 * (`INTERNAL_SERVER_ERROR`, `ERROR_UNEXPECTED_ANSWER`, `QUERY_LIMIT_EXCEEDED`, `OPERATION_TIME_LIMIT`).
 * Без этого шлюз при выкладке, ответивший `{"error": "gateway_timeout", "error_description": …}`,
 * отпускал бы разовый шаг обустройства навсегда (безопасность и `/review` в закрывающем круге панели
 * PR #106).
 *
 * ⚠ `invalid_grant` в ответе на вызов — не наш вердикт: мёртвым грант признаёт только продление токена
 * (`fromTokenRefresh`). Иначе любой, кто держит тело ответа, — шлюз, прокси, — запускал бы отсчёт
 * до стирания токенов (безопасность там же).
 */
function fromAnswer(failure: AxiosLike, message: string): PortalError {
  const response = failure.response
  const named = response == null ? null : refusalCodeIn(response.data)
  if (response == null || named === null || isDeadGrantCode(named)) return new PortalError(UNREACHABLE_CODE, message)
  const final = typeof response.status === 'number' && isFinalRefusalStatus(response.status)
  if (named === '') return new PortalError(final ? REJECTED_CODE : '', message)
  if (final || isRetryableCode(named)) return new PortalError(named, message)
  // Код портала стираем, но статус — в журнал: иначе при выкладке было бы не видно, что повтор идёт
  // из-за ответа портала. Самого незнакомого кода в журнале нет — он не из нашего списка (`/review`).
  logger.warn({ status: response.status }, 'портал ответил незнакомым кодом при временном статусе — повторим')
  return new PortalError('', message)
}

/**
 * Classify a failed token refresh: a dead grant, or no portal answer at all.
 *
 * ⚠ МЁРТВЫЙ ГРАНТ — при любом статусе ответа с ошибкой. Сетью `invalid_grant` не получить, а признание
 * мёртвого гранта — единственный способ узнать об уходе клиента: сдвинь SDK статус в новой версии
 * (`^2.2.0`), и правило по статусу молча спрятало бы его (безопасность в панели PR #106). Ответ 2xx
 * с `invalid_grant` сюда не доезжает: его SDK бросает своим `SdkError` без `RefreshTokenError`,
 * и код остаётся только в тексте (issue #111).
 *
 * ⚠ ВСЁ ПРОЧЕЕ — `UNREACHABLE_CODE`: токена нет, до портала вызов не дошёл, и вердикта о самом вызове
 * никто не выносил. Тот же принцип у нашего обмена токена (`server/b24/oauth.ts`): всё, чего нет
 * в `REJECTION_CODES`, — `kind: 'unavailable'`, в сторону повтора. Списки при этом разные: там три кода
 * подлинности гранта, здесь один (`DEAD_GRANT_CODES`). Вторая редакция пропускала название, если
 * у ошибки был настоящий статус, — и пропускала лишнее: код сети при оборванном теле (`ECONNRESET`
 * со статусом 200), `"0"`, `server_error` с 503 и `invalid_client` — нашу собственную пару ключей,
 * которую чинит исправленная настройка, а не отметка шага навсегда. Нашли `/review`, программист,
 * безопасность, `/code-review` и тестировщик во втором круге панели PR #106.
 *
 * Код сервера авторизации при этом уходит в журнал: иначе наша пара ключей на всём флоте
 * (`invalid_client`) выглядела бы бедой связи (программист и технический директор в закрывающем
 * круге). Только из своего списка (`AUTH_CODES`) или код транспорта — прочее пишется «не код».
 */
function fromTokenRefresh(code: string, message: string): PortalError {
  if (isDeadGrantCode(code)) return new PortalError(code, message)
  logger.warn({ code: AUTH_CODES.includes(code) || TRANSPORT_CODE.test(code) ? code : 'не код' }, 'продление токена не удалось — вызов до портала не дошёл')
  return new PortalError(UNREACHABLE_CODE, message)
}

/**
 * Classify an error with no network error behind it: one the SDK parsed out of a portal body, or ours.
 *
 * Из тела без сети за спиной приходят ошибка ответа 2xx (`AjaxResult`, ключ `base-error`) и отказ команды
 * пакета — ошибка, разобранная из её записи в `result_error`. Самого тела здесь нет — его разобрал SDK, —
 * поэтому код проверяется только формой (`isPortalCode`). `"0"` SDK заменяет своим `JSSDK_RESPONSE_ERROR`,
 * и это отказ портала без кода; `invalid_grant` — не наш вердикт, как и в `fromAnswer`. Всё прочее — наше
 * исключение (запись продлённых токенов в базу, свой таймаут) или код SDK: не вердикт портала.
 */
function fromResult(error: Error): PortalError {
  if (!(error instanceof AjaxError)) return new PortalError('', error.message)
  const code = codeOf(error)
  if (code === CODELESS_IN_BODY) return new PortalError(REJECTED_CODE, error.message)
  return new PortalError(isPortalCode(code) && !isDeadGrantCode(code) ? code : '', error.message)
}

/** An axios error as far as we read it: the response, with its status and body. */
interface AxiosLike {
  response?: { status?: unknown, data?: unknown } | null
}

/** Whether a value is an axios error — what the SDK keeps in `originalError` when a call went over the network. */
function isAxiosError(value: unknown): value is AxiosLike {
  return value !== null && typeof value === 'object' && (value as { isAxiosError?: unknown }).isAxiosError === true
}

/** The machine code of an error object, when it is a string. A foreign structure — read defensively. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : ''
}

/**
 * Whether a refusal at this status is a verdict on the call: 4xx, except 408 and 429.
 *
 * «Портал не дождался запроса» и «притормозите» лечит время, как и 5xx. Предел запросов приходит
 * со своим кодом (`OPERATION_TIME_LIMIT`, `QUERY_LIMIT_EXCEEDED`), но без кода — тоже время. Та же
 * граница у самого SDK (`RestrictionManager`, неповторимые ошибки клиента).
 */
function isFinalRefusalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/** Limit the wait for one call. The timer is cleared so it does not keep the process alive. */
async function withTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${method}: портал не ответил за ${CALL_TIMEOUT_MS} мс`)), CALL_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
