import type { H3Event } from 'h3'
import { createError, readBody } from 'h3'
import { makePortalCall } from '../../b24/client'
import { verifyFrameToken } from '../../b24/frame-auth'
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
  /** Кто пришёл. Нужен, чтобы в отчёте о ссылках было видно, кто её выпустил. */
  userId: number
  isAdmin: boolean
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

  return { portal, userId: check.userId, isAdmin: check.isAdmin, call: makeCall(portal) }
}

/**
 * Собрать вызов портала от сохранённых токенов.
 *
 * Обновлённые токены сохраняются сразу: SDK меняет их молча, и не записать значит отправить
 * следующий запуск со старой парой, которая после обмена мертва.
 */
function makeCall(portal: IssuingPortal): RestCall {
  const accessToken = decryptOrEmpty(portal.accessToken)
  const refreshToken = decryptOrEmpty(portal.refreshToken)
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
      applicationToken: decryptOrEmpty(portal.applicationToken),
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

/** Пустая строка вместо исключения: негодный токен обрабатывается выше, одним понятным отказом. */
function decryptOrEmpty(blob: string | null): string {
  if (blob === null || blob === '') return ''
  try {
    return decryptSecret(blob)
  }
  catch {
    return ''
  }
}
