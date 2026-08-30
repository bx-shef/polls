/**
 * Content-Security-Policy for both audiences of this app.
 *
 * Раньше эти заголовки ставил свой nginx. На общем хосте перед нами стоит один
 * `nginx-proxy` на все проекты — он занимается только TLS и маршрутизацией и ничего
 * не знает про Битрикс24. Поэтому политика переехала в приложение: это единственное
 * место, которое знает, какая страница кому показывается.
 */

/**
 * Региональные зоны Битрикс24.
 *
 * Список неочевиден и стоит того, чтобы лежать в одном месте: у части зон адрес
 * двухсегментный (`com.br`, `com.tr`), а без нужной зоны в `frame-ancestors` портал
 * покажет пустой iframe и ничего не объяснит.
 */
export const BITRIX24_ZONES = [
  'ru',
  'by',
  'kz',
  'ua',
  'com',
  'eu',
  'de',
  'fr',
  'it',
  'es',
  'pl',
  'in',
  'jp',
  'vn',
  'mx',
  'id',
  'com.br',
  'com.tr',
] as const

const bitrix24Origins = BITRIX24_ZONES.map(zone => `https://*.bitrix24.${zone}`).join(' ')

/**
 * Политика для приложения внутри портала.
 *
 * `unsafe-inline` и `unsafe-eval` здесь нужны самому Битрикс24; сузить их можно только
 * своей проверкой в живом портале, а не заодно с чем-то другим.
 */
export const portalCsp = [
  'default-src \'self\'',
  'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\'',
  'style-src \'self\' \'unsafe-inline\'',
  'img-src \'self\' data: https:',
  `connect-src 'self' ${bitrix24Origins}`,
  `frame-ancestors ${bitrix24Origins}`,
  'object-src \'none\'',
  'frame-src \'none\'',
  'base-uri \'none\'',
].join('; ')

/**
 * Политика для публичной страницы анкеты.
 *
 * Её открывает посторонний респондент, встраивать её в чужие страницы незачем —
 * отсюда `frame-ancestors 'none'`. `unsafe-inline` в `script-src` остаётся временно:
 * Nuxt встраивает полезную нагрузку инлайновым скриптом, и замена на nonce — отдельная
 * работа вместе с самой страницей (issue #2).
 */
export const publicPageCsp = [
  'default-src \'self\'',
  'script-src \'self\' \'unsafe-inline\'',
  'style-src \'self\' \'unsafe-inline\'',
  'img-src \'self\' data:',
  'connect-src \'self\'',
  'object-src \'none\'',
  'frame-src \'none\'',
  'frame-ancestors \'none\'',
  'base-uri \'none\'',
  'form-action \'self\'',
].join('; ')
