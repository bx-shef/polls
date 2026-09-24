import type { H3Event } from 'h3'
import { createError, getRequestHeader, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { callForPortal } from '../../b24/from-record'
import { verifyFrameToken } from '../../b24/frame-auth'
import { trustedAddress } from '../../domain/links/rate-limit'
import { countAndDecidePortal } from '../../links/rate'
import type { RestBatch, RestCall } from '../../b24/provision'
import { findPortalByMemberId, type IssuingPortal } from '../../links/issue'
import { isDatabaseConfigured } from '../../db/client'
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
   * Его же имя, как его знает портал. Пусто — у сотрудника не заполнено.
   *
   * ⚠ Приезжает даром: проверка фреймового токена идёт методом `profile`, а он отдаёт
   * `NAME`/`LAST_NAME` вместе с `ID`. Спросить имя отдельно было бы нечем — скоупа
   * `user`/`user_brief` приложение не запрашивает.
   *
   * ⚠ В журнал НЕ пишется. Идентификатора (`userId`) для разбора «кто выдал ссылку»
   * достаточно, а имя — лишние персональные данные в файле, который переживёт инцидент.
   */
  userName: string
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
  /** Он же пакетом: несколько связанных чтений за одно обращение. */
  batch: RestBatch
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

  const caller = callForPortal(portal)
  if (caller === null) {
    // Токенов нет или они не читаются. Наружу — 503: это наша беда, а не вина обратившегося,
    // и повторить запрос осмысленно, когда её починят.
    throw createError({ statusCode: 503, statusMessage: 'Portal not authorised' })
  }

  return {
    portal,
    userId: check.userId,
    userName: check.userName,
    authId,
    call: caller.call,
    batch: caller.batch,
  }
}
