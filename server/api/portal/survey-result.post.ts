import { createError, defineEventHandler, readBody } from 'h3'
import { verifyItemAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { readAllPublishedTemplates } from '../../b24/read-templates'
import { buildFieldName } from '../../domain/portals/smart-processes'
import { isSurveyCard } from '../../domain/portals/userfield-type'
import type { SurveyTemplate } from '../../domain/surveys/model'
import { buildResultSections, readAnswersField, readScoresField } from '../../domain/surveys/result-view'
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
 * ⚠ ДОСТУП ПРОВЕРЯЕТСЯ ТОКЕНОМ СОТРУДНИКА, и здесь это важнее, чем у шаблонов: там лежат
 * наши же анкеты, а тут — ответы клиентов. Читаем мы токеном приложения, у которого прав
 * больше, значит «а можно ли этому человеку» обязан решать портал.
 *
 * ⚠ ПОЛЕ МОГУТ ЗАВЕСТИ НЕ ТАМ. Тип виден администратору в списке типов полей, и поле
 * «Результат опроса» можно поставить хоть на сделку. Тогда номер элемента — номер сделки,
 * и без проверки владельца мы показали бы «Опрос» с тем же номером. Разбор — у `isSurveyCard`.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)
  const body = await readBody<{ itemId?: unknown, entityId?: unknown, entityTypeId?: unknown }>(event).catch(() => null)

  const itemId = Number(body?.itemId)
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return { ok: false as const, reason: 'no-item' as const }
  }

  const refs = await readStoredRefs(session.call)
  if (refs.survey === undefined || refs.template === undefined) {
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const owner = {
    entityId: typeof body?.entityId === 'string' ? body.entityId.trim() : '',
    entityTypeId: Number.isInteger(Number(body?.entityTypeId)) ? Number(body?.entityTypeId) : null,
  }
  if (!isSurveyCard(owner, refs.survey)) {
    return { ok: false as const, reason: 'foreign-card' as const }
  }

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

  const response = await session.call('crm.item.get', {
    entityTypeId: refs.survey.entityTypeId,
    id: itemId,
    useOriginalUfNames: 'Y',
  }) as { result?: { item?: Record<string, unknown> } }

  const item = response?.result?.item
  if (item === undefined || item === null) return { ok: false as const, reason: 'no-item' as const }

  const survey = refs.survey
  const field = (postfix: string) => item[buildFieldName(survey.id, postfix)]
  const answers = readAnswersField(field('ANSWERS'))
  // Ответов нет — приглашение ещё не прошли. Это не ошибка, и виджет скажет об этом словами.
  if (answers === null) return { ok: true as const, completed: false as const }

  const code = typeof field('TEMPLATE_CODE') === 'string' ? (field('TEMPLATE_CODE') as string).trim() : ''
  const version = Number(field('TEMPLATE_VERSION'))
  const template = code === '' || !Number.isInteger(version)
    ? null
    : await findSchema(session, refs.template, code, version)

  // ⚠ В журнал уходит СКОЛЬКО, а не ЧТО. Число вопросов отвечает на вопрос «виджет вообще
  // что-нибудь нашёл», и этого достаточно для разбора; текст ответа не уходит никогда.
  logger.info({ domain: session.portal.domain, questions: Object.keys(answers).length }, 'результат опроса показан в карточке')

  return {
    ok: true as const,
    completed: true as const,
    title: template?.title ?? code,
    version: Number.isInteger(version) ? version : null,
    sections: buildResultSections(template, answers, readScoresField(field('SCORES'))),
  }
})

/**
 * Схема версии: сначала из нашего кэша, при промахе — с портала.
 *
 * ⚠ Кэш первым, потому что он почти всегда попадает: схема кладётся в него при выпуске ссылки,
 * то есть заведомо раньше, чем у «Опроса» появятся ответы. Перелистывать все шаблоны портала
 * на каждое открытие карточки — это до двадцати вызовов ради того, что у нас уже лежит.
 *
 * ⚠ Портал вторым, потому что кэш — именно кэш: источник истины — «Шаблон опроса», и его
 * запись у нас может пропасть. Без этого шага виджет показал бы вместо вопросов их ключи,
 * и менеджер прочитал бы это как поломку.
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
  return published.find(template => template.code === code && template.version === version)?.schema ?? null
}
