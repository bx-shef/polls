import { createError, defineEventHandler, readBody } from 'h3'
import { verifyDealAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { buildListIssuedCall, buildRevokeCall, isRevocable, readIssuedLinks } from '../../domain/invitations/issued-links'
import { revokeLink } from '../../links/issue'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Revokes one issued link: the page stops opening, the card says it was stopped.
 *
 * ⚠ ЗАЧЕМ. Без отзыва у приложения нет ни одного способа отменить уже совершённое действие:
 * ссылка ушла не тому человеку — и остановить её нельзя ничем, кроме ожидания тридцати дней.
 * Это первое, что спросят при разборе инцидента, и первое, что нужно менеджеру, отправившему
 * ссылку не в тот чат.
 *
 * ⚠ ПОРЯДОК ДВУХ ЗАПИСЕЙ ЗДЕСЬ ГЛАВНОЕ. Сначала гасим НАШУ строку, потом состояние
 * на портале. Страницу закрывает именно наша: публичная страница анкеты в портал не ходит
 * по инварианту, и `decideLinkAccess` смотрит на `link_index.status`. Запись на портале —
 * то, что видит менеджер. Упади мы между ними — ссылка уже не открывается, а карточка ещё
 * говорит «отправлена»: расхождение видно и лечится повторным нажатием. Обратный порядок
 * дал бы карточку «отозвана» при работающей ссылке — то есть ложное спокойствие.
 *
 * ⚠ Проверок доступа ДВЕ, и вторая не лишняя. Первая — видит ли сотрудник эту сделку
 * (фреймовым токеном, как при выпуске). Вторая — принадлежит ли гасимый элемент именно ей:
 * без неё номер элемента из тела запроса позволил бы погасить чужую ссылку, назвав свою сделку.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)

  const body = await readBody<{ dealId?: unknown, itemId?: unknown }>(event)
  const dealId = Number(body?.dealId)
  const itemId = Number(body?.itemId)
  if (!Number.isInteger(dealId) || dealId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
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
    logger.warn({ domain: session.portal.domain }, 'отзыв ссылки: смарт-процесс «Опрос» не найден на портале')
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const listing = buildListIssuedCall(refs.survey, dealId)
  const links = readIssuedLinks(await session.call(listing.method, listing.params), refs.survey)
  const target = links.find(link => link.itemId === itemId)

  if (target === undefined) {
    // Элемент не из этой сделки — или её вовсе не наш. Наружу уходит одно и то же:
    // разница в ответе подсказывала бы, какие элементы на портале существуют.
    return { ok: false as const, reason: 'link-gone' as const }
  }

  if (!isRevocable(target, new Date())) {
    // Пройденную, отозванную и истёкшую гасить нечего. Это не ошибка: кнопку могли нажать
    // на списке, который успел устареть, пока вкладка была открыта.
    return { ok: false as const, reason: 'not-revocable' as const }
  }

  await revokeLink(session.portal.id, itemId)

  const revoke = buildRevokeCall(refs.survey, itemId)
  await session.call(revoke.method, revoke.params)

  logger.info({ domain: session.portal.domain, itemId, userId: session.userId }, 'ссылка отозвана')

  return { ok: true as const }
})
