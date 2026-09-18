import { BITRIX24_ZONES } from '../domain/portals/zones'

/**
 * Content-Security-Policy for the three kinds of response this app produces.
 *
 * Раньше эти заголовки ставил свой nginx. На общем хосте перед нами стоит один
 * `nginx-proxy` на все проекты — он занимается только TLS и маршрутизацией и ничего
 * не знает про Битрикс24. Поэтому политика переехала в приложение: это единственное
 * место, которое знает, какая страница кому показывается.
 *
 * Проставляет их `server/plugins/security-headers.ts`, а не `routeRules` — почему
 * именно так, объяснено там.
 */

const bitrix24Origins = BITRIX24_ZONES.map(zone => `https://*.bitrix24.${zone}`).join(' ')

/**
 * Policy for the app running inside a Bitrix24 portal iframe.
 *
 * `unsafe-inline` и `unsafe-eval` здесь нужны самому Битрикс24; сузить их можно только
 * своей проверкой в живом портале, а не заодно с чем-то другим.
 */
export const portalCsp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: https:`,
  `connect-src 'self' ${bitrix24Origins}`,
  `frame-ancestors ${bitrix24Origins}`,
  `object-src 'none'`,
  `frame-src 'none'`,
  `base-uri 'none'`,
  // `form-action` не наследуется от `default-src`, как и `base-uri`. Без неё
  // инъекция внутри портального контекста отправит форму куда угодно.
  `form-action 'self'`,
].join('; ')

/**
 * Policy for the public survey page.
 *
 * Её открывает посторонний респондент, встраивать её в чужие страницы незачем —
 * отсюда `frame-ancestors 'none'`. `unsafe-inline` в `script-src` остаётся временно:
 * Nuxt встраивает полезную нагрузку инлайновым скриптом, и замена на nonce — отдельная
 * работа вместе с самой страницей (issue #2).
 */
export const publicPageCsp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data:`,
  `connect-src 'self'`,
  `object-src 'none'`,
  `frame-src 'none'`,
  `frame-ancestors 'none'`,
  `base-uri 'none'`,
  `form-action 'self'`,
].join('; ')

/**
 * Policy for JSON endpoints.
 *
 * JSON не рендерится, поэтому политика максимально узкая. Она нужна на случай, если
 * ответ всё же попробуют показать как страницу; портальная политика с `unsafe-eval`
 * и списком доменов здесь была бы не только лишней, но и вводящей в заблуждение.
 */
export const apiCsp = [
  `default-src 'none'`,
  `frame-ancestors 'none'`,
  `base-uri 'none'`,
].join('; ')

/**
 * Security headers for a given request path.
 *
 * Чистая функция, чтобы выбор политики можно было проверить тестом, не поднимая сервер.
 * Проставляет их `server/plugins/security-headers.ts`.
 */
export function securityHeadersFor(path: string): Record<string, string> {
  const common = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // HSTS ставим сами, а не полагаемся на общий прокси: его настройки — не наша зона,
    // а без `includeSubDomains` заголовок слабее того, что был в своём nginx.
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  }

  if (path.startsWith('/api/')) {
    return { ...common, 'Content-Security-Policy': apiCsp }
  }
  if (path.startsWith('/s/')) {
    return { ...common, 'Content-Security-Policy': publicPageCsp, 'X-Robots-Tag': 'noindex, nofollow' }
  }

  // Лендинг — единственная страница, которой в выдаче место. Политика у неё та же, что
  // у публичной анкеты: она тоже вне портала, и встраивать её в чужие страницы незачем.
  if (isLanding(path)) {
    return { ...common, 'Content-Security-Policy': publicPageCsp }
  }

  // Всё остальное — страницы внутри портала: `/app`, `/install`, `/portal/**`.
  //
  // ⚠ `noindex` здесь обязателен, и это не перестраховка. У соседнего проекта служебная
  // страница без него ушла в индекс С МЕТА-ДАННЫМИ ЛЕНДИНГА — то есть по запросу про продукт
  // выдача показывала пустую панель, которая снаружи портала не работает в принципе.
  // Закрываем заголовком, а не `Disallow` в robots.txt: краулер, послушавший `Disallow`,
  // страницу не скачает, не увидит `noindex` и вполне может показать голый адрес
  // по внешней ссылке.
  return { ...common, 'Content-Security-Policy': portalCsp, 'X-Robots-Tag': 'noindex, nofollow' }
}

/**
 * Лендинг — это корень и ничего больше.
 *
 * Сравнение точное, а не `startsWith`: с префиксом под лендинг попало бы всё приложение,
 * потому что с `/` начинается любой путь.
 */
function isLanding(path: string): boolean {
  const withoutQuery = path.split('?')[0] ?? ''
  return withoutQuery === '/' || withoutQuery === ''
}
