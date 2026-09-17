import { createError, defineEventHandler, getRequestHeader, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { refreshTokens } from '../../b24/oauth'
import { registerPortal } from '../../b24/register'
import { trustedAddress } from '../../domain/links/rate-limit'
import { readFrameGrant } from '../../domain/portals/grant'
import { decideGrant } from '../../domain/portals/install'
import { isDatabaseConfigured } from '../../db/client'
import { countAndDecidePortal } from '../../links/rate'
import { b24ClientId, b24ClientSecret } from '../../utils/env'
import { assertEncryptionKey } from '../../utils/crypto'
import { logger } from '../../utils/logger'

/**
 * Installs the app from the setup wizard running inside the portal's iframe.
 *
 * Второй путь установки, и он появился не от хорошей жизни. Тиражное приложение с пунктом
 * в левом меню Битрикс24 считает НЕустановленным, пока страница мастера не вызовет
 * `BX24.installFinish()`. Документация об этом говорит прямо: «Встройки не появятся
 * в интерфейсе, даже если `placement.bind` завершился успешно. События не отправятся
 * на обработчик, даже после успешного `event.bind`». То есть путь через событие
 * `ONAPPINSTALL` в этом режиме не срабатывает вовсе: сервер бы всё создал, портал бы
 * отчитался успехом, а вкладки в сделке не было бы — и причина ненаходима.
 *
 * ⚠ Подлинность доказывается ТЕМ ЖЕ способом, что и у события: переавторизацией гранта
 * на сервере авторизации Битрикс24. Это принципиально. Сюда приходит обычный POST,
 * который может отправить кто угодно с чем угодно; единственное, чего подделать нельзя, —
 * работающий `refresh_token`, который обменивается на пару и возвращает `member_id`,
 * посчитанный не нами и не обращающимся. Проверка живёт в `decideGrant` — одна на оба пути,
 * потому что две копии одной проверки со временем начинают проверять разное.
 *
 * ⚠ Обмен ВРАЩАЕТ грант: присланный `refresh_token` после него мёртв. Поэтому повторный
 * вызов с тем же телом честно отвечает отказом — это не поломка, а следствие. Мастер
 * вызывает нас один раз.
 */
export default defineEventHandler(async (event) => {
  const clientId = b24ClientId()
  const clientSecret = b24ClientSecret()
  // Тот же порядок, что в обработчике события: ключ шифрования проверяется ДО обмена.
  // Упасть на отсутствующем ключе после обмена значит сжечь единственный грант
  // администратора — повторить мастер он сможет, но только переустановив приложение.
  if (clientId === '' || clientSecret === '' || !isDatabaseConfigured() || !assertEncryptionKey()) {
    logger.error('мастер установки: нет B24_CLIENT_ID/B24_CLIENT_SECRET, DATABASE_URL или B24_TOKEN_ENC_KEY')
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  const body = await readBody<{ auth?: unknown }>(event)

  // ⚠ Считаем частоту ДО обмена. Каждый запрос сюда — это исходящий вызов к серверу
  // авторизации Битрикс24 от нашего имени; поток мусорных POST превратился бы в поток
  // наших обращений туда, за который блокируют приложение целиком. Тот же довод,
  // что и в обработчике события, только там защищает предел размера тела.
  const address = trustedAddress(
    getRequestHeader(event, 'x-forwarded-for'),
    event.node.req.socket.remoteAddress ?? '',
  )
  const rate = await countAndDecidePortal(address, 'install')
  if (!rate.allow) {
    logger.warn({ by: rate.by }, 'мастер установки: превышена частота обращений')
    setResponseStatus(event, 429)
    setResponseHeader(event, 'Retry-After', rate.retryAfterSeconds)
    throw createError({ statusCode: 429, statusMessage: 'Too many requests' })
  }

  const parsed = readFrameGrant(body?.auth)
  if (!parsed.ok) {
    logger.warn({ reason: parsed.reason }, 'мастер установки: грант не разобран')
    throw createError({ statusCode: 400, statusMessage: 'Bad grant' })
  }

  const decision = await decideGrant(parsed.grant, {
    reauthorize: refreshToken => refreshTokens({ refreshToken, clientId, clientSecret }),
  })

  if (decision.action === undefined) {
    // Причина — в журнал, наружу только статус: подробный отказ подсказывает подбирающему,
    // какое поле поправить в следующей попытке.
    logger.warn({ reason: decision.reason, status: decision.status }, 'мастер установки: отказано')
    throw createError({ statusCode: decision.status, statusMessage: 'Install rejected' })
  }

  const outcome = await registerPortal(decision.action)
  logger.info({ domain: decision.action.domain, reason: decision.reason, outcome }, 'портал установлен мастером')

  // `provisioned: false` — токены сохранены, смарт-процессы нет. Страница обязана показать
  // это словами, а не завершить установку молча: без смарт-процессов приложение откроется
  // и не сможет ничего, и разбираться будут уже на живом клиенте.
  return { ok: true as const, provisioned: outcome === 'ok' }
})
