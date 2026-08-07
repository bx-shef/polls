import { securityHeaders, parseExtraFrameAncestors } from '~core/api/security-headers'

/**
 * Вешает заголовки безопасности на КАЖДЫЙ ответ приложения.
 *
 * Тонкая обёртка: вся политика — чистая `securityHeaders` в ядре (под тестами), здесь только
 * чтение окружения и запись заголовков. Считаем набор ОДИН раз на процесс — он не зависит от
 * запроса, кроме признака HTTPS, а строка CSP длинная и пересобирать её на каждый ответ незачем.
 *
 * `X-Forwarded-Proto` для HSTS читаем осознанно: прод стоит за общим nginx-proxy, и сам процесс
 * видит http. Заголовок здесь клиент-управляемый, но цена подделки нулевая — максимум клиент
 * попросит поставить себе же HSTS.
 *
 * Middleware не отвечает и не прерывает цепочку: только добавляет заголовки и пропускает дальше.
 */
const extra = parseExtraFrameAncestors(process.env.CSP_FRAME_ANCESTORS)
const secure = securityHeaders({ extraFrameAncestors: extra, https: true })
const plain = securityHeaders({ extraFrameAncestors: extra, https: false })

export default defineEventHandler((event) => {
  const proto = getRequestHeader(event, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const isHttps = proto === 'https' || event.node.req.socket && 'encrypted' in event.node.req.socket
  setResponseHeaders(event, isHttps ? secure : plain)
})
