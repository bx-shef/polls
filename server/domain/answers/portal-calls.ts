import { buildFieldName } from '../portals/smart-processes'
import type { PortalCall, SmartProcessRef } from '../portals/smart-processes'
import type { AnswerValue } from '../surveys/answer'
import type { SurveyScore } from '../surveys/scoring'

/**
 * Portal calls that record a completed survey.
 *
 * Зеркало `../invitations/portal-calls.ts`: там приглашение создаётся, здесь закрывается.
 * Чистые билдеры, транспорт у вызывающего.
 *
 * ⚠ Везде `useOriginalUfNames: 'Y'` — по той же причине, что и при выпуске: поля мы создавали
 * как `UF_CRM_<id>_STATE`, а по умолчанию `crm.item.*` адресует их в camelCase.
 */

/** Состояние пройденного опроса. Те же слова, что в нашем кэш-индексе ссылок. */
export const SURVEY_STATE_COMPLETED = 'completed'

/** Тип сущности для таймлайна сделки. Строка, а не число: у `crm.timeline.*` своя номенклатура. */
export const TIMELINE_DEAL_TYPE = 'deal'

/**
 * Записать ответ в элемент смарт-процесса «Опрос».
 *
 * ⚠ Этот вызов и есть доставка. Всё остальное — комментарий в таймлайн — удобство: ответ
 * живёт здесь, и после успеха этого вызова наш буфер больше не единственное место, где он есть.
 * Порядок именно такой, потому что инвариант звучит «ответ клиента не теряется никогда»,
 * а не «комментарий не теряется никогда».
 *
 * Идемпотентен: повторный вызов с теми же полями ставит те же значения. Это важно —
 * повтор задачи после обрыва не должен бояться уже записанного.
 */
export function buildCompleteSurveyCall(
  survey: SmartProcessRef,
  itemId: number,
  result: {
    answers: Record<string, AnswerValue>
    score: SurveyScore
    completedAt: Date
  },
): PortalCall {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: survey.entityTypeId,
      id: itemId,
      useOriginalUfNames: 'Y',
      fields: {
        [buildFieldName(survey.id, 'STATE')]: SURVEY_STATE_COMPLETED,
        [buildFieldName(survey.id, 'COMPLETED_AT')]: result.completedAt.toISOString(),
        // ⚠ `null` уезжает полем как есть, а не нулём: «не ответил» и «поставил ноль» —
        // разные вещи, и на портале они обязаны остаться разными.
        [buildFieldName(survey.id, 'ANSWERS')]: JSON.stringify(result.answers),
        [buildFieldName(survey.id, 'SCORES')]: JSON.stringify(
          result.score.sections.map(s => ({ key: s.key, score: s.score, answered: s.answered, scored: s.scored })),
        ),
        // Общий балл может быть `null` — анкету открыли и отправили, не тронув ни одного
        // балльного вопроса. Ноль тут был бы ложью, поэтому поле просто не ставится.
        ...(result.score.overall === null ? {} : { [buildFieldName(survey.id, 'SCORE')]: result.score.overall }),
      },
    },
  }
}

/** Прочитать элемент опроса — нужен, чтобы узнать, к какой сделке он привязан. */
export function buildReadSurveyItemCall(survey: SmartProcessRef, itemId: number): PortalCall {
  return {
    method: 'crm.item.get',
    params: { entityTypeId: survey.entityTypeId, id: itemId, useOriginalUfNames: 'Y' },
  }
}

/**
 * Достать идентификатор родительской сделки из ответа `crm.item.get`.
 *
 * ⚠ Спрашиваем ПОРТАЛ, а не свою базу, и это не лишний вызов. Связь со сделкой — поле элемента,
 * то есть она в источнике истины, и менеджер мог её поменять после выпуска ссылки. Свой снимок
 * этой связи был бы вторым источником правды, который начал бы расходиться с первого дня.
 *
 * `null` — связи нет: элемент отвязали от сделки. Тогда комментировать нечего, и это не ошибка.
 */
export function readParentDealId(response: unknown, dealEntityTypeId: number): number | null {
  const item = (response as { result?: { item?: Record<string, unknown> } } | null)?.result?.item
  if (item === undefined || item === null) return null

  // Поле-родитель называется `parentId<entityTypeId>` — та же форма, что при создании.
  const raw = item[`parentId${dealEntityTypeId}`]
  const id = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Положить итог опроса в историю сделки.
 *
 * ⚠ Метод НЕЛЬЗЯ класть в батч (`ERROR_BATCH_METHOD_NOT_ALLOWED`) — подтверждено документацией
 * метода. И он НЕ идемпотентен: второй вызов добавит второй комментарий, а не обновит первый.
 *
 * Пустой текст портал отвергает (`INVALID_ARG_VALUE`), поэтому вызывающий обязан убедиться,
 * что строить есть из чего.
 */
export function buildTimelineCommentCall(dealId: number, comment: string): PortalCall {
  return {
    method: 'crm.timeline.comment.add',
    params: { fields: { ENTITY_ID: dealId, ENTITY_TYPE: TIMELINE_DEAL_TYPE, COMMENT: comment } },
  }
}

/** Подтвердить, что портал действительно обновил элемент. */
export function readUpdatedItemId(response: unknown): number | null {
  const raw = (response as { result?: { item?: { id?: unknown } } } | null)?.result?.item?.id
  const id = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(id) && id > 0 ? id : null
}
