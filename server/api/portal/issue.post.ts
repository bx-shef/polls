import { createError, defineEventHandler, readBody } from 'h3'
import { verifyDealAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { readAllPublishedTemplates } from '../../b24/read-templates'
import { issueLink } from '../../links/issue-flow'
import { publicBaseUrl } from '../../utils/env'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Issues one survey link for a deal — the request side of it.
 *
 * Здесь остались ровно три вопроса, и все они про ЭТОТ запрос: кто пришёл, видит ли он
 * эту сделку и ту ли анкету просит. Сам выпуск — общий путь, он живёт
 * в `server/links/issue-flow.ts` и оттуда же вызывается живой проверкой `pnpm verify:link`.
 *
 * ⚠ Разделено именно по этой границе, а не «чтобы файл был короче». Права проверяются
 * ФРЕЙМОВЫМ токеном сотрудника и только здесь: проверка приходит с вебхуком оператора,
 * у которого прав и так больше, и смешать эти два случая в одной функции значило бы однажды
 * получить выпуск без проверки доступа.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)

  const body = await readBody<{ dealId?: unknown, surveyCode?: unknown, surveyVersion?: unknown }>(event)
  const dealId = Number(body?.dealId)
  const surveyCode = typeof body?.surveyCode === 'string' ? body.surveyCode.trim() : ''
  const surveyVersion = Number(body?.surveyVersion)

  if (!Number.isInteger(dealId) || dealId <= 0 || surveyCode === '' || !Number.isInteger(surveyVersion)) {
    throw createError({ statusCode: 400, statusMessage: 'Bad request' })
  }

  // ⚠ Спрашиваем ТОКЕНОМ СОТРУДНИКА, видит ли он эту сделку, и только потом создаём элемент
  // СВОИМ. Без этого приложение — подставное лицо: элемент создаётся токеном с правами шире
  // любого отдельного сотрудника, а номер сделки приходит из параметров фрейма и подменяется
  // тривиально. Нашла панель ревью PR #18.
  const access = await verifyDealAccess(session.portal.domain, session.authId, dealId)
  if (!access.ok) {
    if (access.reason === 'unreachable') {
      throw createError({ statusCode: 503, statusMessage: 'Portal unreachable' })
    }
    // Наружу — ровно то, что человек и так знает: этой сделки он не видит. Ни намёка
    // на то, существует ли она вообще.
    return { ok: false as const, reason: 'deal-denied' as const }
  }

  const refs = await readStoredRefs(session.call)
  if (refs.template === undefined || refs.survey === undefined) {
    logger.warn({ domain: session.portal.domain }, 'выпуск ссылки: смарт-процессы не найдены на портале')
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const published = await readAllPublishedTemplates(session.call, refs.template)
  const chosen = published.find(t => t.code === surveyCode && t.version === surveyVersion)
  if (chosen === undefined) {
    // Шаблон мог быть снят с публикации между открытием вкладки и нажатием кнопки.
    return { ok: false as const, reason: 'survey-gone' as const }
  }

  // ⚠ Дальше — общий путь выпуска, тот же самый, что проходит `pnpm verify:link`. Вынесен
  // в `server/links/issue-flow.ts` ровно затем, чтобы живая проверка не проверяла свою копию:
  // копии расходятся тогда, когда правят одну из них, и замечают это на клиенте.
  const issued = await issueLink({
    call: session.call,
    batch: session.batch,
    portalId: session.portal.id,
    domain: session.portal.domain,
    baseUrl: session.portal.publicHost ?? publicBaseUrl(),
    survey: refs.survey,
    dealId,
    template: chosen,
    // Кто нажал «выпустить» — на него и повесится дело по итогу.
    assignedById: session.userId,
    managerName: session.userName,
  })

  if (!issued.ok) {
    // Два исхода, и наружу они уходят разными кодами: нет публичного адреса — наша беда
    // настройки (503), портал не подтвердил создание — беда портала (502).
    throw issued.reason === 'no-public-host'
      ? createError({ statusCode: 503, statusMessage: 'Public host is not configured' })
      : createError({ statusCode: 502, statusMessage: 'Portal did not create the item' })
  }

  // Токен отдаётся ЕДИНСТВЕННЫЙ раз, здесь. Второй раз узнать его нельзя ни нам, ни клиенту:
  // у нас лежит только хеш.
  return {
    ok: true as const,
    url: issued.url,
    expiresAt: issued.expiresAt.toISOString(),
    itemId: issued.itemId,
  }
})
