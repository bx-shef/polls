import {
  securityHeaders,
  parseExtraFrameAncestors,
  resolveCspMode,
  isHttpsRequest,
  isNoFrameRoute,
  isPrivatePage
} from '~core/api/security-headers'

/**
 * Заголовки безопасности на КАЖДОМ ответе приложения.
 *
 * ⚠️ Почему плагин с хуком `beforeResponse`, а не middleware в `server/middleware/`. Nitro
 * регистрирует обработчик публичных файлов ПЕРЕД сканированными middleware, поэтому middleware не
 * видит статику: проверено на собранном приложении — `/favicon.svg` уходил вообще без заголовков.
 * Обещание «на каждый ответ» было бы враньём, а любой будущий `.html` в `public/` (или включённый
 * пререндер публичной страницы опроса) молча остался бы без `frame-ancestors`. Хук `beforeResponse`
 * срабатывает для любого слоя, включая статику, и до записи ответа.
 *
 * Набор считаем ОДИН раз на процесс: от запроса он зависит лишь признаком HTTPS и тем, публичная это
 * страница опроса или нет. Строка CSP длинная — пересобирать её на каждый ответ незачем.
 *
 * ⚠️ Настройки (`CSP_FRAME_ANCESTORS`, `CSP_MODE`) читаются при старте — после изменения нужен
 * перезапуск контейнера.
 */
export default defineNitroPlugin((nitro) => {
  const extra = parseExtraFrameAncestors(process.env.CSP_FRAME_ANCESTORS)
  const cspMode = resolveCspMode(process.env.CSP_MODE)
  const variant = (https: boolean, noFrame: boolean) =>
    securityHeaders({ extraFrameAncestors: extra, https, cspMode, noFrame })
  const sets = {
    'https:frame': variant(true, false),
    'https:noframe': variant(true, true),
    'http:frame': variant(false, false),
    'http:noframe': variant(false, true)
  }

  nitro.hooks.hook('beforeResponse', (event) => {
    const https = isHttpsRequest({
      // За общим nginx-proxy сам процесс видит http — схему сообщает прокси.
      forwardedProto: getRequestHeader(event, 'x-forwarded-proto'),
      encrypted: Boolean((event.node.req.socket as { encrypted?: boolean }).encrypted)
    })
    const noFrame = isNoFrameRoute(event.path)
    setResponseHeaders(event, sets[`${https ? 'https' : 'http'}:${noFrame ? 'noframe' : 'frame'}`])
    // Персональная страница (опрос по ссылке) — не в общий кэш. Отдельной строкой, а не пятым
    // вариантом набора: признак другой (принадлежность одному человеку, не фрейминг), и совпадение
    // маршрутов у них сегодняшнее, а не обязательное.
    if (isPrivatePage(event.path)) setResponseHeader(event, 'Cache-Control', 'no-store')
  })
})
