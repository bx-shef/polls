import { Buffer } from 'node:buffer'
import { createError, defineEventHandler, getRequestHeader, getRouterParam, readRawBody, setResponseStatus } from 'h3'
import { checkAnswers, MAX_TOTAL_BYTES } from '../../domain/surveys/answer'
import { drainInbox } from '../../answers/deliver'
import { saveAnswer } from '../../links/store'
import { logger } from '../../utils/logger'
import { denied, resolveSurveyAccess } from './-access'

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
 * Считаем с запасом к пределу самой анкеты: JSON вокруг значений тоже весит.
 *
 * ⚠ Заявленный размер проверяется по `Content-Length` ДО чтения тела, и это не придирка
 * к порядку. `readRawBody` копит весь поток в памяти и только потом отдаёт строку — то есть
 * проверка после него срабатывает, когда дорогое уже случилось. Панель ревью PR #15 указала,
 * что комментарий обещал проверку «до разбора», а по факту защищал только от разбора,
 * не от чтения. Заголовку верить нельзя, поэтому фактический размер проверяется тоже.
 */
const MAX_BODY_BYTES = MAX_TOTAL_BYTES * 2

export default defineEventHandler(async (event) => {
  const declared = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Body too large' })
  }

  const access = await resolveSurveyAccess(event, getRouterParam(event, 'token') ?? '')
  if (!access.ok) return access.body

  const raw = await readRawBody(event)
  if (typeof raw !== 'string' || raw === '') {
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    // Границу меряем в байтах, а не в символах: правило проекта, и кириллица весит вдвое.
    throw createError({ statusCode: 413, statusMessage: 'Body too large' })
  }

  const checked = checkAnswers(access.template, parseJson(raw))
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

  const saved = await saveAnswer(access.link, access.tokenHash, {
    surveyCode: access.link.surveyCode,
    surveyVersion: access.link.surveyVersion,
    itemId: access.link.itemId,
    answers: checked.answers,
    submittedAt: new Date().toISOString(),
  })

  if (!saved) {
    // Ссылку закрыли между проверкой и записью — например, человек отправил анкету дважды.
    // Повторная отправка отбивается, и это проверяется живой проверкой `pnpm verify:link`.
    return denied('completed').body
  }

  logger.info({ code: access.link.surveyCode, version: access.link.surveyVersion }, 'анкета: ответ принят в буфер')

  // ⚠ Разбор дёргается, но НЕ ожидается. Респондент уже всё сделал; заставлять его смотреть
  // на крутилку, пока мы ходим в портал, значит поставить его ответ в зависимость от чужой
  // доступности — при том что ответ уже сохранён и доедет в любом случае. Ошибку глотаем
  // здесь же: наверх ей идти некуда, а цикл в плагине разберёт буфер и без этого дёрганья.
  void drainInbox().catch(error =>
    logger.warn({ reason: (error as Error).message }, 'разбор буфера после приёма ответа не удался'),
  )

  return { ok: true as const }
})

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch {
    return null
  }
}
