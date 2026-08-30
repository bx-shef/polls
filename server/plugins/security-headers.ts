import { securityHeadersFor } from '../utils/security-headers'

/**
 * Sets security headers on every successful response.
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
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('beforeResponse', (event) => {
    setResponseHeaders(event, securityHeadersFor(event.path ?? ''))
  })
})
