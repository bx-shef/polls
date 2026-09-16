import { B24OAuth } from '@bitrix24/b24jssdk'
import { b24ClientId, b24ClientSecret } from '../utils/env'
import type { RestCall } from './provision'

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
 * Собрать вызов метода портала.
 *
 * `onRefresh` вызывается, когда SDK сам обновил токены: сохранять их обязательно, иначе
 * следующий запуск пойдёт со старой парой, а она после обмена мертва. Персист — только
 * UPDATE, чтобы операция была идемпотентной при нескольких репликах.
 */
export function makePortalCall(auth: PortalAuth, onRefresh?: (next: { accessToken: string, refreshToken: string, expiresIn: number }) => Promise<void>): RestCall {
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

  return async (method, params = {}) => {
    const response = await withTimeout(client.actions.v2.call.make({ method, params }), method)
    if (!response.isSuccess) {
      // Текст ошибки портала нужен целиком: по нему различаются нет прав, нет метода
      // и исчерпан лимит смарт-процессов. Токенов в нём не бывает: SDK пропускает текст
      // через свой `redactSensitiveParams`, а сырую транспортную ошибку не сериализует.
      throw new Error(response.getErrorMessages().join('; '))
    }
    return response.getData()
  }
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
