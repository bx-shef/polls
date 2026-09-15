import { B24OAuth } from '@bitrix24/b24jssdk'
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
 */

/** Адрес сервера авторизации. Тот же, что у обмена токена, и он же в примерах самого SDK. */
const SERVER_ENDPOINT = 'https://oauth.bitrix.info/rest/'

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
      status: 'F',
    },
    { clientId: process.env.B24_CLIENT_ID ?? '', clientSecret: process.env.B24_CLIENT_SECRET ?? '' },
    {
      restrictionParams: {
        // ⚠ Одна попытка, без повторов: см. шапку файла.
        maxRetries: 1,
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
    const response = await client.actions.v2.call.make({ method, params })
    if (!response.isSuccess) {
      // Текст ошибки портала нужен целиком: по нему различаются нет прав, нет метода
      // и исчерпан лимит смарт-процессов. Токенов в нём не бывает.
      throw new Error(response.getErrorMessages().join('; '))
    }
    return response.getData()
  }
}
