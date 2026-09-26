import { createError, defineEventHandler, readBody } from 'h3'
import { verifyItemAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { readAllPublishedTemplates } from '../../b24/read-templates'
import { buildFieldName } from '../../domain/portals/smart-processes'
import { isSurveyCard } from '../../domain/portals/userfield-type'
import type { SurveyTemplate } from '../../domain/surveys/model'
import { buildResultSections, readAnswersField, readScoresField } from '../../domain/surveys/result-view'
import { cacheTemplate } from '../../links/issue'
import { findTemplate } from '../../links/store'
import { logger } from '../../utils/logger'
import { openPortalSession, type PortalSession } from './-session'

/**
 * Reads one survey element and hands the card widget a readable result.
 *
 * ⚠ ЧТО ЗДЕСЬ ЛЕЖИТ. Ответы клиента — текст, который набрал посторонний человек. Он уходит
 * в карточку, которую смотрит сотрудник, и это законно; но у НАС он не задерживается нигде
 * и НЕ ПОПАДАЕТ В ЖУРНАЛ — ни в отладке, ни временно. Это инвариант проекта, и здесь он
 * значит буквально: в `logger` из этого файла не уходит ничего, кроме домена и числа вопросов.
 *
 * ⚠ ЭЛЕМЕНТ ЧИТАЕТСЯ ТОКЕНОМ СОТРУДНИКА, одним вызовом с проверкой доступа (`verifyItemAccess`).
 * Токеном приложения, у которого прав больше, мы показали бы и то, что портал этому человеку
 * не показал бы, — например, поле, закрытое правами. Решать, что ему видно, обязан портал.
 *
 * ⚠ ПОЛЕ МОГУТ ЗАВЕСТИ НЕ ТАМ. Тип виден администратору в списке типов полей, и поле
 * «Результат опроса» можно поставить хоть на сделку. Тогда номер элемента — номер сделки,
 * и без проверки владельца мы показали бы «Опрос» с тем же номером. Разбор — у `isSurveyCard`;
 * там же — почему это защита от ошибки администратора, а не граница прав.
 *
 * Последовательность шагов держит `tests/unit/survey-result-api.test.ts`.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)
  const body = await readBody<{ itemId?: unknown, entityId?: unknown, entityTypeId?: unknown }>(event).catch(() => null)

  const itemId = positiveInteger(body?.itemId)
  if (itemId === null) return { ok: false as const, reason: 'no-item' as const }

  const refs = await readStoredRefs(session.call)
  if (refs.survey === undefined || refs.template === undefined) {
    // Установка не доработала — это не то, что менеджер должен угадывать по пустому полю.
    logger.warn({ domain: session.portal.domain }, 'виджет результата: смарт-процессы опросов на портале не найдены')
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const owner = {
    entityId: typeof body?.entityId === 'string' ? body.entityId.trim() : '',
    entityTypeId: positiveInteger(body?.entityTypeId),
  }
  // ⚠ «Не прислал признаков» и «прислал чужие» — разные отказы. Первое — сбой встраивания
  // на настоящей карточке «Опроса», и совет «удалите поле» там был бы вредным. Нашёл `/code-review`.
  if (owner.entityId === '' && owner.entityTypeId === null) return { ok: false as const, reason: 'no-owner' as const }
  if (!isSurveyCard(owner, refs.survey)) return { ok: false as const, reason: 'foreign-card' as const }

  const access = await verifyItemAccess(
    session.portal.domain,
    session.authId,
    refs.survey.entityTypeId,
    itemId,
  )
  if (!access.ok) {
    if (access.reason === 'unreachable') {
      throw createError({ statusCode: 503, statusMessage: 'Portal unreachable' })
    }
    return { ok: false as const, reason: 'denied' as const }
  }

  const survey = refs.survey
  const field = (postfix: string) => access.item[buildFieldName(survey.id, postfix)]
  const answers = readAnswersField(field('ANSWERS'))
  // Ответов нет — приглашение ещё не прошли. Это не ошибка; состояние уходит наружу, чтобы
  // виджет не обещал ответа по истёкшей или отозванной ссылке, по которой его уже не будет.
  if (answers === null) return { ok: true as const, completed: false as const, state: readState(field('STATE')) }

  const code = typeof field('TEMPLATE_CODE') === 'string' ? (field('TEMPLATE_CODE') as string).trim() : ''
  // ⚠ Строго положительное целое. `Number(null) === 0` и `Number('') === 0` проходят
  // `Number.isInteger`, и пустая версия превращалась в версию 0: промах кэша на каждом открытии
  // и перелистывание всех шаблонов портала впустую. Нашли `/review` и `/code-review`.
  const version = positiveInteger(field('TEMPLATE_VERSION'))
  const template = code === '' || version === null
    ? null
    : await findSchema(session, refs.template, code, version)

  // ⚠ В журнал уходит СКОЛЬКО, а не ЧТО. Число вопросов отвечает на вопрос «виджет вообще
  // что-нибудь нашёл», и этого достаточно для разбора; текст ответа не уходит никогда.
  logger.info({ domain: session.portal.domain, questions: Object.keys(answers).length }, 'результат опроса показан в карточке')

  return {
    ok: true as const,
    completed: true as const,
    // `||`, а не `??`: пустое название — тоже «нет названия», как у списка анкет во вкладке сделки.
    title: template?.title || code,
    version,
    sections: buildResultSections(template, answers, readScoresField(field('SCORES'))),
  }
})

/** Состояния приглашения, которые виджет различает словами. Остальные — «ещё не ответил». */
const KNOWN_STATES = new Set(['created', 'sent', 'opened', 'completed', 'revoked', 'expired'])

function readState(raw: unknown): string {
  const state = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return KNOWN_STATES.has(state) ? state : ''
}

/** Строго положительное целое либо `null`. Пустота — не ноль. */
function positiveInteger(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const value = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Схема версии: сначала из нашего кэша, при промахе — с портала, и найденное — обратно в кэш.
 *
 * ⚠ Кэш первым, потому что он почти всегда попадает: схема кладётся в него при выпуске ссылки,
 * то есть заведомо раньше, чем у «Опроса» появятся ответы. Перелистывать все шаблоны портала
 * на каждое открытие карточки — это до двадцати вызовов ради того, что у нас уже лежит.
 *
 * ⚠ Портал вторым, потому что кэш — именно кэш: источник истины — «Шаблон опроса», и его
 * запись у нас может пропасть. Без этого шага виджет показал бы вместо вопросов их ключи.
 *
 * ⚠ Найденное ЗАПИСЫВАЕТСЯ ОБРАТНО. Без этого промах повторялся бы на каждом открытии каждой
 * карточки этой анкеты — до двадцати вызовов в чужой портал за раз. Нашли безопасность,
 * `/review` и `/code-review` независимо. Схема версии неизменяема, так что запись не может
 * устареть; неудача записи виджет не роняет — показать уже есть что.
 */
async function findSchema(
  session: PortalSession,
  templateRef: { entityTypeId: number, id: number },
  code: string,
  version: number,
): Promise<SurveyTemplate | null> {
  const cached = await findTemplate(session.portal.id, code, version)
  if (cached !== null) return cached

  const published = await readAllPublishedTemplates(session.call, templateRef)
  const schema = published.find(template => template.code === code && template.version === version)?.schema ?? null
  if (schema === null) return null

  try {
    await cacheTemplate(session.portal.id, code, version, schema)
  }
  catch (error) {
    logger.warn({ domain: session.portal.domain, reason: (error as Error).message }, 'схема анкеты не записана в кэш')
  }
  return schema
}
