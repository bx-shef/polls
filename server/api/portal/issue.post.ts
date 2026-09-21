import { createError, defineEventHandler, readBody } from 'h3'
import { buildSurveyUrl, createInvitation } from '../../domain/invitations/invitation'
import {
  buildCreateSurveyItemCall,
  buildReadDealClientCall,
  readDealClient,
  buildListTemplatesCall,
  readCreatedItemId,
  readPublishedTemplates,
} from '../../domain/invitations/portal-calls'
import { verifyDealAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { cacheTemplate, insertLink } from '../../links/issue'
import { publicBaseUrl } from '../../utils/env'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Issues one survey link for a deal.
 *
 * Порядок шагов здесь и есть смысл файла, и он не переставляется:
 *
 * 1. Схема кладётся в кэш ДО того, как ссылка попадёт человеку. Публичная страница в портал
 *    не ходит по инварианту, и промах кэша — это пожизненный 503 по выданной ссылке.
 * 2. Элемент смарт-процесса создаётся ВТОРЫМ: приглашение и есть этот элемент, источник
 *    истины — портал.
 * 3. Хеш токена пишется в наш кэш-индекс ПОСЛЕДНИМ, когда известен идентификатор элемента.
 *
 * Если что-то падает на третьем шаге, на портале остаётся элемент без ссылки — это видно
 * и чинится перевыпуском. Обратный порядок оставил бы ссылку, ведущую в никуда, а её уже
 * нельзя отозвать: она у человека в письме.
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

  const listCall = buildListTemplatesCall(refs.template)
  const published = readPublishedTemplates(await session.call(listCall.method, listCall.params), refs.template)
  const chosen = published.find(t => t.code === surveyCode && t.version === surveyVersion)
  if (chosen === undefined) {
    // Шаблон мог быть снят с публикации между открытием вкладки и нажатием кнопки.
    return { ok: false as const, reason: 'survey-gone' as const }
  }

  const baseUrl = session.portal.publicHost ?? publicBaseUrl()
  const invitation = createInvitation({}, new Date())

  const url = buildSurveyUrl(baseUrl, invitation.token)
  if (url === null) {
    // Без `https`-хоста ссылка означала бы токен доступа к чужой анкете, летящий открытым
    // текстом. Лучше не выпустить, чем выпустить такую.
    logger.error({ domain: session.portal.domain }, 'выпуск ссылки: публичный адрес не настроен или не https')
    throw createError({ statusCode: 503, statusMessage: 'Public host is not configured' })
  }

  await cacheTemplate(session.portal.id, chosen.code, chosen.version, chosen.schema)

  // ⚠ Клиент сделки переносится в приглашение СНИМКОМ. Отдельный вызов, и он оправдан:
  // без клиента карточка «Опроса» отвечает, по какой сделке опрос, но не отвечает, кого
  // спрашивали, — а это первое, зачем её открывают. Неудача чтения ссылку НЕ роняет:
  // ссылка важнее удобства карточки, и поменять их местами было бы ошибкой.
  let client
  try {
    const clientCall = buildReadDealClientCall(dealId)
    client = readDealClient(await session.call(clientCall.method, clientCall.params))
  }
  catch {
    logger.warn({ domain: session.portal.domain }, 'клиент сделки не прочитан, приглашение уйдёт без него')
  }

  const createCall = buildCreateSurveyItemCall(refs.survey, dealId, {
    templateCode: chosen.code,
    templateVersion: chosen.version,
    expiresAt: invitation.expiresAt,
    title: chosen.title,
    client,
  })
  const itemId = readCreatedItemId(await session.call(createCall.method, createCall.params))
  if (itemId === null) {
    logger.error({ domain: session.portal.domain }, 'выпуск ссылки: портал не вернул идентификатор элемента')
    throw createError({ statusCode: 502, statusMessage: 'Portal did not create the item' })
  }

  await insertLink({
    portalId: session.portal.id,
    tokenHash: invitation.tokenHash,
    itemId,
    surveyCode: chosen.code,
    surveyVersion: chosen.version,
    expiresAt: invitation.expiresAt,
  })

  // ⚠ В журнал уходит что угодно, кроме токена и его хеша. Ссылка живёт тридцать дней,
  // а журналы переживают инцидент и утекают вместе с ним.
  logger.info(
    { domain: session.portal.domain, code: chosen.code, version: chosen.version, itemId, userId: session.userId },
    'ссылка выпущена',
  )

  // Токен отдаётся ЕДИНСТВЕННЫЙ раз, здесь. Второй раз узнать его нельзя ни нам, ни клиенту:
  // у нас лежит только хеш.
  return { ok: true as const, url, expiresAt: invitation.expiresAt.toISOString(), itemId }
})
