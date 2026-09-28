import { createError, defineEventHandler, readBody } from 'h3'
import { verifyDealAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { buildListIssuedCall, buildRevokeCall, issuedState, needsRevokeRepair, readIssuedLinks } from '../../domain/invitations/issued-links'
import { readLinkStatuses } from '../../links/issue'
import { safeRefusal } from '../../domain/answers/portal-errors'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * How many lost revokes one opening of the tab writes back to the portal, at most.
 *
 * ⚠ Дописывание стоит на пути ответа, и каждое — вызов портала. Копится расхождение, только когда
 * портал отказывал на отзывах, то есть обычно их ноль или одно; предел держит вкладку быстрой
 * и в худшем случае, а остальное допишут следующие открытия. Нашёл `/code-review` в панели PR #93.
 */
const MAX_REPAIRS_PER_VIEW = 3

/**
 * Lists the links already issued for a deal.
 *
 * ⚠ ЗАЧЕМ ЭТО ВООБЩЕ. Вкладка умела ровно одно: выпустить ссылку и показать её один раз.
 * Закрыл вкладку — и узнать, выпускал ли ты что-нибудь по этой сделке, было нельзя: у нас
 * лежит только хеш токена, а адрес в элемент «Опроса» пишется лишь с #87 (поле «Ссылка
 * на анкету»). То есть без списка менеджер выпускает вторую ссылку просто потому, что
 * не помнит про первую.
 *
 * ⚠ Список читается С ПОРТАЛА, а не из нашей базы. Каждая выпущенная ссылка и есть элемент
 * смарт-процесса «Опрос»; у нас лежит только то, чего в портале быть не может. Разбор —
 * в `server/domain/invitations/issued-links.ts`. Одно исключение — «отозвана»: её решает наша
 * строка, которая и закрывает страницу, а не стадия, которую двигают в канбане (там же).
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
  const statuses = await readLinkStatuses(session.portal.id, links.map(link => link.itemId))
  const now = new Date()

  // ⚠ Отзыв, чья вторая запись не дошла до портала, дописывается здесь — там, где расхождение видно
  // всегда. Повторным нажатием его не починить после обновления вкладки: по нашей строке ссылка уже
  // «отозвана», и кнопки у неё нет. Без этого элемент навсегда стоял бы «Отправленным», а роботы
  // клиента на «Отозвана» не сработали бы. Неудача список не роняет — починит следующее открытие.
  // Нашёл `/review` в третьем круге панели PR #93. Параллельно и не больше предела — там же, почему.
  const survey = refs.survey
  const lost = links.filter(one => needsRevokeRepair(one, statuses.get(one.itemId) ?? null)).slice(0, MAX_REPAIRS_PER_VIEW)
  await Promise.allSettled(lost.map(async (link) => {
    try {
      const repair = buildRevokeCall(survey, link.itemId)
      await session.call(repair.method, repair.params)
      logger.info({ domain: session.portal.domain, itemId: link.itemId }, 'отзыв ссылки дописан на портал')
    }
    catch (error) {
      logger.warn({ domain: session.portal.domain, itemId: link.itemId, reason: safeRefusal(error) }, 'отзыв ссылки не дописан на портал')
    }
  }))

  return {
    ok: true as const,
    // ⚠ Наружу уходит состояние, а не сырые поля: считать «просрочена ли» в браузере значило бы
    // считать это по часам рабочей станции сотрудника, которые с порталом никто не сверял.
    links: links.map(link => ({
      itemId: link.itemId,
      title: link.title,
      code: link.code,
      version: link.version,
      state: issuedState(link, now, statuses.get(link.itemId) ?? null),
      expiresAt: link.expiresAt,
      completedAt: link.completedAt,
      score: link.score,
      assignedById: link.assignedById,
      createdAt: link.createdAt,
    })),
  }
})
