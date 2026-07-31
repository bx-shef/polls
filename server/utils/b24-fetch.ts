import type { HttpFetch, HttpResponse } from '~core/bitrix24/oauth'

/**
 * Таймаут исходящих HTTP к Bitrix24 (`oauth.bitrix.info` — рефреш токена; `<portal>/rest/app.info` —
 * проверка фрейм-токена в handshake). Ядро (`Bitrix24OAuth`/`createPortalAuthenticator`) намеренно
 * делегирует таймауты «слою деплоя» — этот слой здесь. Без лимита зависший upstream держал бы соединение
 * до дефолта undici (~300с): у keep-alive это пинит весь проход по порталам, у handshake/install — копит
 * сокеты и event-loop. `AbortSignal.timeout` → fetch reject → ядро отдаёт транзиентную ошибку (503/ретрай).
 *
 * SERVER-ONLY. Единая точка (раньше константа/обёртка дублировались в install.post и deal-update.post).
 */
export const B24_FETCH_TIMEOUT_MS = 10_000

export const timeoutFetch: HttpFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(B24_FETCH_TIMEOUT_MS) }) as Promise<HttpResponse>
