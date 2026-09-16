import { Buffer } from 'node:buffer'
import { createError, defineEventHandler, getRouterParam, getRequestIP, readRawBody, setResponseStatus } from 'h3'
import { DENIAL_MESSAGES, decideLinkAccess } from '../../domain/links/access'
import { hashToken, isTokenShaped } from '../../domain/links/token'
import { checkAnswers, MAX_TOTAL_BYTES } from '../../domain/surveys/answer'
import { countAndDecide } from '../../links/rate'
import { findLinkByTokenHash, findTemplate, saveAnswer } from '../../links/store'
import { isDatabaseConfigured } from '../../db/client'
import { logger } from '../../utils/logger'

/**
 * Accepts a filled-in survey.
 *
 * ⚠ Инвариант, который здесь и живёт: ответ клиента не теряется никогда. Сначала буфер,
 * потом попытка записи в портал. Запись в `inbox` и закрытие ссылки идут одной транзакцией —
 * иначе между ними находится окно, в котором ответ уже принят, а ссылка ещё рабочая.
 *
 * ⚠ Ни одна строка этого файла не логирует текст ответа. Даже в отладке, даже временно:
 * логи переживают инцидент и утекают вместе с ним, а это ответ постороннего человека
 * о работе чужой компании.
 */

/**
 * Предел тела запроса, в байтах.
 *
 * Считаем с запасом к пределу самой анкеты: JSON вокруг значений тоже весит. Проверка стоит
 * ДО разбора — тот же приём и та же причина, что в обработчике установки: разбор мегабайтного
 * тела съедает процесс раньше, чем до него дойдёт хоть одна осмысленная проверка.
 */
const MAX_BODY_BYTES = MAX_TOTAL_BYTES * 2

export default defineEventHandler(async (event) => {
  if (!isDatabaseConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  const token = getRouterParam(event, 'token') ?? ''
  if (!isTokenShaped(token)) {
    return refusal('unknown')
  }

  const tokenHash = hashToken(token)
  const rate = await countAndDecide(getRequestIP(event, { xForwardedFor: true }) ?? '', tokenHash)
  if (!rate.allow) {
    logger.warn({ by: rate.by }, 'анкета: превышена частота отправок')
    setResponseStatus(event, 429)
    event.node.res.setHeader('Retry-After', String(rate.retryAfterSeconds))
    return { ok: false as const, reason: 'rate-limited' as const }
  }

  const raw = await readRawBody(event)
  if (typeof raw !== 'string' || raw === '') {
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    // Границу меряем в байтах, а не в символах: правило проекта, и кириллица весит вдвое.
    throw createError({ statusCode: 413, statusMessage: 'Body too large' })
  }

  const link = await findLinkByTokenHash(tokenHash)
  const access = decideLinkAccess(link, new Date())
  if (!access.allow) {
    return refusal(access.reason)
  }

  const template = await findTemplate(link!.portalId, link!.surveyCode, link!.surveyVersion)
  if (template === null) {
    logger.error({ code: link!.surveyCode, version: link!.surveyVersion }, 'анкета: схема версии не найдена в кэше')
    throw createError({ statusCode: 503, statusMessage: 'Survey unavailable' })
  }

  const checked = checkAnswers(template, parseJson(raw))
  if (!checked.ok) {
    // Наружу уходят коды и ключи вопросов, но НЕ присланные значения: эхо чужого ввода
    // в ответе — лишний путь для того, кто ищет, что мы с этим вводом делаем.
    setResponseStatus(event, 422)
    return {
      ok: false as const,
      reason: 'invalid' as const,
      problems: checked.problems.map(p => ({ key: p.key, code: p.code, detail: p.detail })),
    }
  }

  const saved = await saveAnswer(link!, tokenHash, {
    surveyCode: link!.surveyCode,
    surveyVersion: link!.surveyVersion,
    itemId: link!.itemId,
    answers: checked.answers,
    submittedAt: new Date().toISOString(),
  })

  if (!saved) {
    // Ссылку закрыли между проверкой и записью — например, человек отправил анкету дважды.
    // Повторная отправка отбивается, и это проверяется живой проверкой `pnpm verify:link`.
    return refusal('completed')
  }

  logger.info({ code: link!.surveyCode, version: link!.surveyVersion }, 'анкета: ответ принят в буфер')
  return { ok: true as const }
})

function refusal(reason: keyof typeof DENIAL_MESSAGES) {
  return { ok: false as const, reason, ...DENIAL_MESSAGES[reason] }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch {
    return null
  }
}
