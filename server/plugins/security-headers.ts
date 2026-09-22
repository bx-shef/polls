import { addNonceToScripts, createNonce } from '../utils/csp-nonce'
import { needsNonce, securityHeadersFor } from '../utils/security-headers'

/**
 * Sets security headers on every successful response, and wires the CSP nonce.
 *
 * Не `routeRules`, хотя там это выглядело бы естественнее: одно место вместо трёх
 * правил, и сюда же попадают `/api/**`, которым портальная политика не подходит.
 *
 * **Ответы с ошибкой сюда не доходят** — проверено запросом: на 404 под `/s/**` этот
 * хук не отрабатывает вовсе. Их обслуживает встроенный обработчик Nitro, и он ставит
 * свои заголовки: `script-src 'none'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`.
 * Это **строже** любой нашей политики, поэтому мы его не перебиваем — попытка «починить»
 * это, подставив свою CSP, только ослабила бы страницу ошибки.
 *
 * Побочное следствие, которое стоит помнить: `X-Frame-Options: DENY` не даст показать
 * нашу страницу ошибки внутри iframe портала — вместо текста ошибки сотрудник увидит
 * пустой фрейм. Разбираться с этим имеет смысл вместе с интерфейсом портала (задача 4).
 */

/** Ключ, под которым nonce живёт от рендера до заголовка. Один запрос — один nonce. */
const NONCE_KEY = 'cspNonce'

export default defineNitroPlugin((nitro) => {
  /**
   * ⚠ ПОРЯДОК ВАЖЕН, И ОН ИМЕННО ТАКОЙ: `render:html` отрабатывает во время рендера,
   * `beforeResponse` — после. Поэтому nonce рождается здесь, кладётся в контекст запроса
   * и оттуда попадает в заголовок. Сделав наоборот, мы бы ставили заголовок с nonce,
   * которого нет в разметке, — то есть блокировали бы собственную страницу.
   */
  nitro.hooks.hook('render:html', (html, { event }) => {
    if (!needsNonce(event.path ?? '')) return

    const nonce = createNonce()
    event.context[NONCE_KEY] = nonce

    // Скрипты Nuxt лежат в обоих кусках: `importmap` и модуль входа — в голове,
    // `window.__NUXT__` и блок payload — в хвосте тела. Проверено на собранном приложении.
    html.head = html.head.map(part => addNonceToScripts(part, nonce))
    html.bodyAppend = html.bodyAppend.map(part => addNonceToScripts(part, nonce))
  })

  nitro.hooks.hook('beforeResponse', (event) => {
    const nonce = event.context[NONCE_KEY]
    setResponseHeaders(event, securityHeadersFor(event.path ?? '', typeof nonce === 'string' ? nonce : undefined))
  })
})
