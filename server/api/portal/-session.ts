import type { H3Event } from 'h3'
import { createError, getRequestHeader, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { makePortalCall } from '../../b24/client'
import { verifyFrameToken } from '../../b24/frame-auth'
import { trustedAddress } from '../../domain/links/rate-limit'
import { countAndDecidePortal } from '../../links/rate'
import type { RestCall } from '../../b24/provision'
import { findPortalByMemberId, saveRefreshedTokens, type IssuingPortal } from '../../links/issue'
import { isDatabaseConfigured } from '../../db/client'
import { decryptSecret, encryptSecret } from '../../utils/crypto'
import { logger } from '../../utils/logger'

/**
 * Turns a request from the app's iframe into a portal-authorised session.
 *
 * Общая прихожая для всех портальных экранов. Порядок один и тот же: разобрать тело, найти
 * портал по `member_id`, спросить портал, настоящий ли фреймовый токен, и только потом
 * собрать вызов от НАШЕГО сохранённого токена.
 *
 * ⚠ Фреймовый токен служит пропуском, а не рабочим ключом. Работаем мы своим OAuth-токеном:
 * у него наши скоупы и наш контекст приложения, а фреймовый живёт час и принадлежит сотруднику.
 * Путать их значит однажды обнаружить, что половина операций работает только пока открыта
 * вкладка.
 *
 * Имя файла с дефиса — соглашение Nitro: такой файл не становится роутом.
 */

export interface PortalSession {
  portal: IssuingPortal
  /** Кто пришёл. Пишется в журнал выпуска — по нему видно, кто выдал ссылку. */
  userId: number
  /**
   * Фреймовый токен сотрудника.
   *
   * ⚠ Живёт только внутри одного запроса и НЕ сохраняется. Нужен там, где надо спросить
   * портал от имени человека, а не приложения: у приложения прав больше, и без такого
   * вопроса оно становится подставным лицом.
   */
  authId: string
  /** Вызов портала от имени приложения. */
  call: RestCall
}

/**
 * Открыть сессию или отказать.
 *
 * Отказы намеренно скупы на подробности: экран внутри портала видит сотрудник, но запрос
 * к нему может прислать кто угодно, и разница в тексте ответа подсказывала бы, какой
 * `member_id` существует, а какой нет.
 */
export async function openPortalSession(event: H3Event): Promise<PortalSession> {
  if (!isDatabaseConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  const body = await readBody<{ memberId?: unknown, authId?: unknown }>(event).catch(() => null)
  const memberId = typeof body?.memberId === 'string' ? body.memberId.trim() : ''
  const authId = typeof body?.authId === 'string' ? body.authId.trim() : ''
  if (memberId === '' || authId === '') {
    throw createError({ statusCode: 400, statusMessage: 'Bad request' })
  }

  // ⚠ Считаем ДО обращения в портал. Каждый запрос сюда — это исходящий вызов в Битрикс24
  // клиента, и без предела похищенный фреймовый токен превращается в усилитель нагрузки
  // на чужой портал. Нашла панель ревью PR #18.
  const address = trustedAddress(
    getRequestHeader(event, 'x-forwarded-for'),
    event.node.req.socket.remoteAddress ?? '',
  )
  const rate = await countAndDecidePortal(address, memberId)
  if (!rate.allow) {
    logger.warn({ by: rate.by }, 'портальный экран: превышена частота обращений')
    setResponseStatus(event, 429)
    setResponseHeader(event, 'Retry-After', rate.retryAfterSeconds)
    throw createError({ statusCode: 429, statusMessage: 'Too many requests' })
  }

  const portal = await findPortalByMemberId(memberId)
  if (portal === null || portal.status === 'deleted') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  // ⚠ Домен берём из НАШЕЙ записи, а не из запроса: иначе проверка превращается в SSRF,
  // и обращающийся получает «подтверждение» от собственного сервера.
  const check = await verifyFrameToken(portal.domain, authId)
  if (!check.ok) {
    if (check.reason === 'unreachable') {
      logger.warn({ domain: portal.domain }, 'портал недоступен для проверки фреймового токена')
      throw createError({ statusCode: 503, statusMessage: 'Portal unreachable' })
    }
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  return { portal, userId: check.userId, authId, call: makeCall(portal) }
}

/**
 * Собрать вызов портала от сохранённых токенов.
 *
 * Обновлённые токены сохраняются сразу: SDK меняет их молча, и не записать значит отправить
 * следующий запуск со старой парой, которая после обмена мертва.
 *
 * ⚠ Бросает 503, когда сохранённых токенов нет или они не расшифровываются. Функция выглядит
 * чистой сборкой, но это прихожая HTTP-слоя, и отказ здесь — такой же ответ, как 403 выше.
 */
function makeCall(portal: IssuingPortal): RestCall {
  const accessToken = decryptOrEmpty(portal.accessToken, 'access')
  const refreshToken = decryptOrEmpty(portal.refreshToken, 'refresh')
  if (accessToken === '' || refreshToken === '') {
    logger.error({ domain: portal.domain }, 'у портала нет пригодных токенов')
    throw createError({ statusCode: 503, statusMessage: 'Portal not authorised' })
  }

  const expiresIn = portal.tokenExpiresAt === null
    ? 0
    : Math.max(0, Math.floor((portal.tokenExpiresAt.getTime() - Date.now()) / 1000))

  return makePortalCall(
    {
      memberId: portal.memberId,
      domain: portal.domain,
      accessToken,
      refreshToken,
      applicationToken: decryptOrEmpty(portal.applicationToken, 'application'),
      expiresIn,
      scope: portal.scopes ?? [],
    },
    async next => saveRefreshedTokens(portal.id, {
      accessToken: encryptSecret(next.accessToken),
      refreshToken: encryptSecret(next.refreshToken),
      expiresAt: new Date(Date.now() + next.expiresIn * 1000),
    }),
  )
}

/**
 * Пустая строка вместо исключения: негодный токен обрабатывается выше, одним понятным отказом.
 *
 * ⚠ Неудача расшифровки логируется ОТДЕЛЬНО от «токена не было». Это разные беды: первая
 * означает, что ключ шифрования сменили без `B24_TOKEN_ENC_KEY_OLD`, и тогда «портал
 * не авторизован» приезжает сразу у всех порталов — по общему сообщению это не отличить
 * от единичной поломки. В журнал уходит факт, не содержимое.
 */
function decryptOrEmpty(blob: string | null, field: string): string {
  if (blob === null || blob === '') return ''
  try {
    return decryptSecret(blob)
  }
  catch (error) {
    logger.error({ field, reason: (error as Error).message }, 'токен портала не расшифровался')
    return ''
  }
}
