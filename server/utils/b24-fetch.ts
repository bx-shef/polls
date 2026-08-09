import type { HttpFetch, HttpResponse } from '~core/bitrix24/oauth'
import { outgoingCallAttributes } from '~core/obs/telemetry'
import { withDependencySpan } from '~core/obs/span'

/**
 * Таймаут исходящих HTTP к внешним сервисам (Bitrix24, GitHub) (`oauth.bitrix.info` — рефреш токена; `<portal>/rest/profile` —
 * проверка фрейм-токена в handshake). Ядро (`Bitrix24OAuth`/`createPortalAuthenticator`) намеренно
 * делегирует таймауты «слою деплоя» — этот слой здесь. Без лимита зависший upstream держал бы соединение
 * до дефолта undici (~300с): у keep-alive это пинит весь проход по порталам, у handshake/install — копит
 * сокеты и event-loop. `AbortSignal.timeout` → fetch reject → ядро отдаёт транзиентную ошибку (503/ретрай).
 *
 * SERVER-ONLY. Единая точка (раньше константа/обёртка дублировались в install.post и deal-update.post).
 */
export const B24_FETCH_TIMEOUT_MS = 10_000

/**
 * ⚠️ Спан вешается ЗДЕСЬ, а не в местах вызова, по той же причине, по которой здесь живёт таймаут: это
 * единственная точка инъекции для ОБОИХ путей — проверки фрейм-токена (`<портал>/rest/profile`) и
 * рефреша OAuth-токена. `callMethod` покрывает только REST через SDK, эти два шли мимо него.
 *
 * В спан идут стадия и ХЕШ домена (`outgoingCallAttributes`), но НЕ сам URL: в адресе портала стоит
 * его домен, то есть имя заказчика.
 */
/**
 * Соль для `portal.hash` — из ключа шифрования токенов портала. Отдельной переменной не заводим: она
 * бы разъехалась с деплоем, а требования те же (секрет, свой на установку). Ключа нет → соли нет →
 * атрибута нет (fail-closed): потерять корреляцию лучше, чем отдать домен заказчика перебором.
 */
const hashSalt = (): string => process.env.NUXT_BITRIX_TOKEN_KEY ?? ''

export const timeoutFetch: HttpFetch = (url, init) => {
  // Считаем ОДИН раз: два вызова означали бы два разбора URL и два HMAC на каждый запрос, в том
  // числе при выключенной телеметрии.
  const attrs = outgoingCallAttributes(String(url), hashSalt())
  return withDependencySpan(
    `b24 http ${attrs.stage}`,
    attrs,
    () => fetch(url, { ...init, signal: AbortSignal.timeout(B24_FETCH_TIMEOUT_MS) }) as Promise<HttpResponse>
  )
}
