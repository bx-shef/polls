import type { H3Event } from 'h3'
import { createError, getRequestHeader, setResponseHeader, setResponseStatus } from 'h3'
import { DENIAL_MESSAGES, decideLinkAccess, type LinkDenial } from '../../domain/links/access'
import { trustedAddress } from '../../domain/links/rate-limit'
import { hashToken, isTokenShaped } from '../../domain/links/token'
import { countAndDecide } from '../../links/rate'
import { findLinkByTokenHash, findTemplate, type StoredLink } from '../../links/store'
import { isDatabaseConfigured } from '../../db/client'
import { logger } from '../../utils/logger'
import type { SurveyTemplate } from '../../domain/surveys/model'

/**
 * The gauntlet every request to a survey link runs, before anything specific happens.
 *
 * Показ анкеты и приём ответа делают разное, но путь к ним один: форма токена → частота →
 * поиск ссылки → статусная машина → схема анкеты. Раньше он был выписан в обоих обработчиках
 * почти дословно; панель ревью PR #15 указала, что расхождение между двумя копиями заметят
 * не раньше, чем оно выстрелит.
 *
 * Имя файла с дефиса — соглашение Nitro: такой файл не становится роутом.
 */

export type SurveyAccess
  = | { ok: true, link: StoredLink, template: SurveyTemplate, tokenHash: string }
    | { ok: false, body: DenialBody }

export interface DenialBody {
  ok: false
  reason: LinkDenial | 'rate-limited'
  title: string
  detail: string
}

const RATE_LIMITED = {
  title: 'Слишком много попыток',
  detail: 'Подождите минуту и откройте ссылку ещё раз.',
}

/**
 * Пройти путь до анкеты или объяснить, почему не вышло.
 *
 * ⚠ Отказы по состоянию ссылки возвращаются телом с кодом 200, а не бросаются ошибкой.
 * По этой ссылке приходит посторонний человек, и на любой исход он должен увидеть понятный
 * текст, а не страницу ошибки браузера. Разные коды на разные исходы заодно превратили бы
 * ответ в оракул: по коду перебирающий отличал бы существующие токены от несуществующих.
 *
 * Кодом отвечают только два случая, и оба не про состояние ссылки: 429 на превышение частоты
 * (это про поведение обращающегося) и 503, когда у НАС нет базы или схемы анкеты в кэше.
 */
export async function resolveSurveyAccess(event: H3Event, token: string): Promise<SurveyAccess> {
  if (!isDatabaseConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  // ⚠ Форма проверяется ДО обращения к базе и до хеширования: перебор по коротким
  // и кривым значениям не должен стоить нам запроса.
  if (!isTokenShaped(token)) {
    return denied('unknown')
  }

  const tokenHash = hashToken(token)
  const address = trustedAddress(
    getRequestHeader(event, 'x-forwarded-for'),
    event.node.req.socket.remoteAddress ?? '',
  )
  const rate = await countAndDecide(address, tokenHash)
  if (!rate.allow) {
    // В журнал уходит причина и ничего больше: ни токена, ни его хеша, ни адреса.
    logger.warn({ by: rate.by }, 'анкета: превышена частота обращений')
    setResponseStatus(event, 429)
    // `Retry-After` типизирован числом: h3 сам приведёт его к строке заголовка.
    setResponseHeader(event, 'Retry-After', rate.retryAfterSeconds)
    return { ok: false, body: { ok: false, reason: 'rate-limited', ...RATE_LIMITED } }
  }

  const link = await findLinkByTokenHash(tokenHash)
  // Проверяем на `null` здесь, а не полагаемся на `decideLinkAccess`: компилятор не видит
  // связи между `allow: true` и тем, что ссылка нашлась, и дальше пришлось бы утверждать
  // это руками через `!` — то есть держать знание там, где его никто не проверит.
  if (link === null) {
    return denied('unknown')
  }

  const access = decideLinkAccess(link, new Date())
  if (!access.allow) {
    return denied(access.reason)
  }

  const template = await findTemplate(link.portalId, link.surveyCode, link.surveyVersion)
  if (template === null) {
    // Промах кэша означает не «сходи в портал», а «ссылку выпустили неправильно»:
    // схема кладётся в кэш при выпуске, то есть заведомо раньше этого запроса.
    logger.error({ code: link.surveyCode, version: link.surveyVersion }, 'анкета: схема версии не найдена в кэше')
    throw createError({ statusCode: 503, statusMessage: 'Survey unavailable' })
  }

  return { ok: true, link, template, tokenHash }
}

/** Отказ телом: причина и человеческое объяснение, без подробностей о портале и клиенте. */
export function denied(reason: LinkDenial): SurveyAccess & { ok: false } {
  return { ok: false, body: { ok: false, reason, ...DENIAL_MESSAGES[reason] } }
}
