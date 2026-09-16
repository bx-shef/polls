import { createError, defineEventHandler, getRouterParam, getRequestIP, setResponseStatus } from 'h3'
import { DENIAL_MESSAGES, decideLinkAccess } from '../../domain/links/access'
import { hashToken, isTokenShaped } from '../../domain/links/token'
import { countAndDecide } from '../../links/rate'
import { findLinkByTokenHash, findTemplate, markOpened } from '../../links/store'
import { isDatabaseConfigured } from '../../db/client'
import { logger } from '../../utils/logger'
import { toPublicSurvey } from './-view'

/**
 * Serves the public survey page with what it needs to render.
 *
 * Отвечает ВСЕГДА кодом 200, даже когда ссылка не найдена или истекла, и это не небрежность.
 * По этой ссылке приходит посторонний человек, и на любой исход он должен увидеть понятный
 * текст, а не страницу ошибки браузера. Разные коды на разные исходы заодно превратили бы
 * ответ в оракул: по коду перебирающий отличал бы существующие токены от несуществующих.
 *
 * Исключение одно — 429: превышение частоты не про состояние ссылки, а про поведение
 * обращающегося, и здесь честный код важнее ровного вида.
 */
export default defineEventHandler(async (event) => {
  if (!isDatabaseConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  const token = getRouterParam(event, 'token') ?? ''
  // ⚠ Форма проверяется ДО обращения к базе и до хеширования: перебор по коротким
  // и кривым значениям не должен стоить нам запроса.
  if (!isTokenShaped(token)) {
    return denial('unknown')
  }

  const tokenHash = hashToken(token)
  const rate = await countAndDecide(getRequestIP(event, { xForwardedFor: true }) ?? '', tokenHash)
  if (!rate.allow) {
    // В журнал уходит причина и ничего больше: ни токена, ни его хеша, ни адреса.
    logger.warn({ by: rate.by }, 'анкета: превышена частота обращений')
    setResponseStatus(event, 429)
    event.node.res.setHeader('Retry-After', String(rate.retryAfterSeconds))
    return { ok: false as const, reason: 'rate-limited' as const, ...RATE_LIMITED }
  }

  const link = await findLinkByTokenHash(tokenHash)
  const access = decideLinkAccess(link, new Date())
  if (!access.allow) {
    return denial(access.reason)
  }

  const template = await findTemplate(link!.portalId, link!.surveyCode, link!.surveyVersion)
  if (template === null) {
    // Промах кэша означает не «сходи в портал», а «ссылку выпустили неправильно»:
    // схема кладётся в кэш при выпуске, то есть заведомо раньше этого запроса.
    logger.error({ code: link!.surveyCode, version: link!.surveyVersion }, 'анкета: схема версии не найдена в кэше')
    throw createError({ statusCode: 503, statusMessage: 'Survey unavailable' })
  }

  // Отмечаем открытие ПОСЛЕ того, как убедились, что показывать есть что: иначе ссылка
  // считалась бы открытой в случае, когда человек увидел ошибку.
  await markOpened(link!.id)

  return { ok: true as const, survey: toPublicSurvey(template) }
})

const RATE_LIMITED = {
  title: 'Слишком много попыток',
  detail: 'Подождите минуту и откройте ссылку ещё раз.',
}

function denial(reason: keyof typeof DENIAL_MESSAGES) {
  return { ok: false as const, reason, ...DENIAL_MESSAGES[reason] }
}
