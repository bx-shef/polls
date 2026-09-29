import { AjaxError, B24OAuth, RefreshTokenError } from '@bitrix24/b24jssdk'
import { b24ClientId, b24ClientSecret } from '../utils/env'
import type { PortalCaller, RestCall } from './provision'
import { isDeadGrantCode } from '../domain/portals/lifecycle'
import { PortalError, REJECTED_CODE, UNREACHABLE_CODE } from '../domain/portals/portal-error'
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
 */
export function makePortalCall(auth: PortalAuth, onRefresh?: (next: { accessToken: string, refreshToken: string, expiresIn: number }) => Promise<void>): PortalCaller {
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
      serverEndpoint: SERVER_ENDPOINT,
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
    // ⚠ SDK БРОСАЕТ отказ портала, а не возвращает его результатом. Проверено зондом против
    // настоящего SDK 2.2.0: ответ `400 {"error":"ACCESS_DENIED"}` приезжает исключением
    // `AjaxError`, и ветка `!response.isSuccess` не достигается вовсе. Первая редакция строила
    // `PortalError` только в этой ветке — то есть почти никогда, и весь разбор кодов снова
    // работал вслепую. Нашла повторная панель ревью PR #34; первая нашла предыдущий слой
    // той же ошибки. Мягким результатом SDK отдаёт лишь десяток «встроенных» кодов,
    // остальное летит исключением.
    let response
    try {
      response = await withTimeout(client.actions.v2.call.make({ method, params }), method)
    }
    catch (error) {
      throw asPortalError(error)
    }
    if (!response.isSuccess) {
      // Мягкий отказ: тот самый десяток кодов, которые SDK не бросает. Форма ответа
      // другая, код достаётся из набора ошибок результата (`softRefusal`).
      throw softRefusal(response.getErrors(), response.getErrorMessages().join('; '))
    }
    return response.getData()
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
   *
   * ⚠ Отказ отдельной команды пишется в журнал ЗДЕСЬ, а не у вызывающего. Иначе он
   * не пишется нигде: вызывающий видит просто отсутствующий ключ и не отличает
   * «у сделки нет компании» от «портал отказал в правах». В журнал уходит имя команды
   * и код отказа — ни параметров, ни данных клиента.
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
      // Код проводится через тот же разбор, что и одиночный вызов: SDK заворачивает отказ
      // команды в свой `JSSDK_BATCH_SUB_ERROR`, пряча настоящий код внутрь.
      for (const [name, error] of Object.entries(response.getErrorsByKey())) {
        logger.warn({ command: name, code: asPortalError(error).code }, 'команда пакета не отработала')
      }
    }

    return (response.getData() ?? {}) as Record<string, unknown>
  }

  return { call, batch }
}

/**
 * Привести брошенное SDK к `PortalError` с машинным кодом.
 *
 * ⚠ Порядок предпочтения кодов НЕ произвольный, и обратный порядок я уже написал —
 * его поймал `tests/unit/portal-call-errors.test.ts` в первом же прогоне. Два случая:
 *
 * | Что случилось | `.code` | `.originalError.code` | Что верно |
 * |---|---|---|---|
 * | Портал отказал методу | `ACCESS_DENIED` | `ERR_BAD_REQUEST` (axios) | внешний |
 * | Грант мёртв | `JSSDK_UNKNOWN_ERROR` | `invalid_grant` | внутренний |
 *
 * То есть внешний код верен ВСЕГДА, кроме случая, когда SDK подставил свой обобщённый:
 * отказ сервера авторизации он заворачивает в `JSSDK_UNKNOWN_ERROR`, пряча настоящий код
 * в `originalError`. Оба факта проверены зондом против настоящего SDK 2.2.0 и закреплены тестом.
 *
 * ⚠ РЕШАЕТ ИСТОЧНИК ОШИБКИ И ТЕЛО ОТВЕТА, а не имя кода и не статус (issue #99). Документация
 * велит распознавать ошибку «по составу полей в теле ответа, а не по HTTP-статусу» («Коды ошибок»).
 * Источников четыре, и у каждого своё правило:
 *
 * | Источник | Как узнать | Правило |
 * |---|---|---|
 * | Ответ на вызов | `originalError` — ошибка axios | `fromAnswer`: тело ответа |
 * | Продление токена | `originalError` — `RefreshTokenError` | `fromTokenRefresh` |
 * | Отказ команды пакета | `originalError` — `AjaxError` команды | её код, как прежде |
 * | Наше исключение, код SDK | всё прочее | пусто: это не отказ портала |
 *
 * Прежде всё решалось по префиксу кода — и в обе стороны неверно. Сетевой код SDK (`ECONNRESET`)
 * доезжал до `PortalError.code` как код портала, и разрыв связи на разовом шаге обустройства отмечал
 * ревизию навсегда. А отказ проверки с пустым кодом SDK сводит к `ERR_BAD_REQUEST`, и он считался
 * повторимым: портал проходил обустройство целиком каждый час вечно. Нашёл `/review` в панели PR #98.
 * Первая редакция исправления решала по статусу — и панель PR #106 нашла, что статус не прямой
 * признак: страница прокси с 403 выходила «отказом портала», а обрыв посреди сжатого тела приходит
 * уже с настоящим статусом и снова становился кодом портала.
 *
 * ⚠ Наш собственный таймаут (`withTimeout`) сюда тоже попадает. У него кода нет, и это
 * правильно: он не отказ портала, а наше решение не ждать дольше.
 */
export function asPortalError(error: unknown): PortalError {
  if (error instanceof PortalError) return error
  if (!(error instanceof Error)) return new PortalError('', String(error))

  const original = (error as { originalError?: unknown }).originalError
  if (isAxiosError(original)) return fromAnswer(codeOf(error), original, error.message)
  if (original instanceof RefreshTokenError) return fromTokenRefresh(original, error.message)
  // Отказ команды пакета (`JSSDK_BATCH_SUB_ERROR`): внутри — ошибка команды с кодом портала.
  if (original instanceof AjaxError) return asPortalError(original)

  // Ошибка без ответа за спиной. Код портала она несёт, только если это ошибка результата SDK
  // (команда пакета, мягкий результат) с названным кодом. Всё прочее — код SDK или наше исключение
  // (запись продлённых токенов в базу): код системы или базы здесь не код портала.
  const code = codeOf(error)
  return new PortalError(error instanceof AjaxError && isPortalName(code) ? code : '', error.message)
}

/**
 * Refusal of a call the portal answered — or did not: decided by the response body.
 *
 * - ответа нет, или в теле нет ключа `error` (страница прокси или WAF, тело оборвалось посреди
 *   передачи) — `UNREACHABLE_CODE`: портал не отказывал, повтор лечит;
 * - портал назвал код — он и решает. SDK берёт код из тела, а когда там пусто или `"0"`,
 *   подставляет код axios `ERR_*` (`parse-error-payload.mjs`: `error !== "0" ? error : fallbackCode`),
 *   поэтому «назвал» — это любой код, кроме кодов SDK и axios;
 * - портал отказал без кода — `REJECTED_CODE` на 4xx, кроме 408 и 429; 5xx, 408 и 429 без кода
 *   лечит время.
 */
function fromAnswer(code: string, answer: AxiosLike, message: string): PortalError {
  const response = answer.response
  if (response === undefined || response === null || !hasErrorKey(response.data)) {
    return new PortalError(UNREACHABLE_CODE, message)
  }
  if (isPortalName(code)) return new PortalError(code, message)
  return new PortalError(typeof response.status === 'number' && isCodelessRefusalStatus(response.status) ? REJECTED_CODE : '', message)
}

/**
 * Refusal of a token refresh: decided by whether the authorization server answered.
 *
 * ⚠ МЁРТВЫЙ ГРАНТ — ВСЕГДА, при любом статусе. Сетью `invalid_grant` не получить, а признание мёртвого
 * гранта — единственный способ узнать об уходе клиента: сдвинь SDK статус в новой версии (`^2.2.0`), и
 * правило по статусу молча спрятало бы его (безопасность в панели PR #106).
 *
 * Прочее: сервер авторизации ответил (статус настоящий) и назвал код — он и решает; нет — ответа
 * не было (статус 0, `status: error.response?.status || 0` в `dist/esm/oauth/auth.mjs`) или это
 * страница шлюза (код axios): `UNREACHABLE_CODE`. Тела здесь не видно — SDK его не сохраняет, — так что
 * обрыв посреди ответа сервера авторизации (статус настоящий, код сети) остаётся кодом. Ответы там
 * крошечные, и случай принят.
 */
function fromTokenRefresh(refusal: RefreshTokenError, message: string): PortalError {
  const code = codeOf(refusal)
  if (isDeadGrantCode(code)) return new PortalError(code, message)
  const status = statusOf(refusal)
  return new PortalError(status !== null && status > 0 && isPortalName(code) ? code : UNREACHABLE_CODE, message)
}

/**
 * Soft refusal: the codes SDK returns in a result instead of throwing.
 *
 * `JSSDK_RESPONSE_ERROR` SDK ставит, когда портал ответил ошибкой с кодом `"0"` (`ajax-result.mjs`):
 * портал отказал, но кода не назвал. Прочие коды SDK наружу как коды портала не выдаются.
 */
function softRefusal(errors: Iterable<Error>, message: string): PortalError {
  const code = firstCode(errors)
  if (code === 'JSSDK_RESPONSE_ERROR') return new PortalError(REJECTED_CODE, message)
  return new PortalError(isPortalName(code) ? code : '', message)
}

/** Ошибка axios в той мере, в какой её читаем: ответ — статус и тело. */
interface AxiosLike {
  response?: { status?: unknown, data?: unknown } | null
}

/** Ошибка axios: SDK кладёт её в `originalError`, когда вызов ушёл по сети. */
function isAxiosError(value: unknown): value is AxiosLike {
  return value !== null && typeof value === 'object' && (value as { isAxiosError?: unknown }).isAxiosError === true
}

/** Ответ портала — ошибка: в теле ключ `error` («Коды ошибок»: проверять наличие ключа, а не значение). */
function hasErrorKey(body: unknown): boolean {
  return body !== null && typeof body === 'object' && 'error' in body
}

/** Код, который назвал портал, а не SDK и не axios. */
function isPortalName(code: string): boolean {
  return code !== '' && !code.startsWith('JSSDK_') && !code.startsWith('ERR_')
}

/** Машинный код объекта ошибки, если он строкой. Чужая структура — читаем защитно. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : ''
}

/** HTTP-статус ошибки SDK (`SdkError.status`); `null` — его нет вовсе. */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null | undefined)?.status
  return typeof status === 'number' ? status : null
}

/**
 * Статус, при котором отказ портала без кода — окончательный.
 *
 * 4xx, кроме 408 и 429: «портал не дождался запроса» и «притормозите» лечит время. Предел запросов
 * приходит со своим кодом (`OPERATION_TIME_LIMIT`, `QUERY_LIMIT_EXCEEDED`), но без кода — тоже время.
 * Та же граница у самого SDK (`RestrictionManager`, неповторимые ошибки клиента).
 */
function isCodelessRefusalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/** Ограничить ожидание одного вызова. Таймер снимается, чтобы не держать процесс живым. */
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

/**
 * Первый непустой машинный код из набора ошибок ответа.
 *
 * ⚠ Набор, а не одна ошибка, — потому что такова форма `Result`, а не потому что мы ждём
 * нескольких: пакетных вызовов в проекте нет ни одного, и на этом пути их быть не может.
 * Первая редакция объясняла цикл батчем — это описывало сценарий, которого в кодовой базе
 * не существует, и отправляло бы читателя искать несуществующий вызов. Нашла повторная
 * панель ревью PR #34.
 *
 * Поле читается защитно: это чужая структура, и обещания «там всегда строка» у нас нет.
 */
function firstCode(errors: Iterable<Error>): string {
  for (const error of errors) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return ''
}
