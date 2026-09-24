import { createError, defineEventHandler, readBody } from 'h3'
import { verifyDealAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { buildListIssuedCall, issuedState, readIssuedLinks } from '../../domain/invitations/issued-links'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Lists the links already issued for a deal.
 *
 * ⚠ ЗАЧЕМ ЭТО ВООБЩЕ. Вкладка умела ровно одно: выпустить ссылку и показать её один раз.
 * Закрыл вкладку — и узнать, выпускал ли ты что-нибудь по этой сделке, нельзя, а сам токен
 * не покажется больше никогда: у нас лежит только его хеш. То есть без списка менеджер
 * выпускает вторую ссылку просто потому, что не помнит про первую.
 *
 * ⚠ Список читается С ПОРТАЛА, а не из нашей базы. Каждая выпущенная ссылка и есть элемент
 * смарт-процесса «Опрос»; у нас лежит только то, чего в портале быть не может. Разбор —
 * в `server/domain/invitations/issued-links.ts`.
 *
 * ⚠ Доступ к сделке проверяется ФРЕЙМОВЫМ ТОКЕНОМ сотрудника, как и при выпуске. Читаем мы
 * своим токеном — у него прав больше любого отдельного сотрудника, — а номер сделки приходит
 * из параметров фрейма и подменяется тривиально. Без этой проверки вкладка стала бы способом
 * прочитать чужие опросы по номеру сделки.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)

  const body = await readBody<{ dealId?: unknown }>(event)
  const dealId = Number(body?.dealId)
  if (!Number.isInteger(dealId) || dealId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Bad request' })
  }

  const access = await verifyDealAccess(session.portal.domain, session.authId, dealId)
  if (!access.ok) {
    if (access.reason === 'unreachable') {
      throw createError({ statusCode: 503, statusMessage: 'Portal unreachable' })
    }
    return { ok: false as const, reason: 'deal-denied' as const }
  }

  const refs = await readStoredRefs(session.call)
  if (refs.survey === undefined) {
    logger.warn({ domain: session.portal.domain }, 'список ссылок: смарт-процесс «Опрос» не найден на портале')
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const listing = buildListIssuedCall(refs.survey, dealId)
  const links = readIssuedLinks(await session.call(listing.method, listing.params), refs.survey)
  const now = new Date()

  return {
    ok: true as const,
    // ⚠ Наружу уходит состояние, а не сырые поля: считать «просрочена ли» в браузере значило бы
    // считать это по часам рабочей станции сотрудника, которые с порталом никто не сверял.
    links: links.map(link => ({
      itemId: link.itemId,
      title: link.title,
      code: link.code,
      version: link.version,
      state: issuedState(link, now),
      expiresAt: link.expiresAt,
      completedAt: link.completedAt,
      score: link.score,
      assignedById: link.assignedById,
      createdAt: link.createdAt,
    })),
  }
})
