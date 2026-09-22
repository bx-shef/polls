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

/** Подтвердить, что портал действительно обновил элемент. */
export function readUpdatedItemId(response: unknown): number | null {
  const raw = (response as { result?: { item?: { id?: unknown } } } | null)?.result?.item?.id
  const id = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Какие поля связи портал вернул на самом деле.
 *
 * ⚠ Диагностика, а не логика: по этим именам ничего не решается. Нужна потому, что
 * `readParentDealId` возвращает `null` двумя способами — связи действительно нет, и связь
 * есть, но названа не так, как мы ждём. Различить их по коду нельзя, а цена ошибки разная:
 * первое штатно, второе означает, что комментарий не придёт НИКОГДА и молча.
 *
 * Повод не умозрительный. `normalizeFieldName` в `../portals/smart-processes.ts` существует
 * ровно потому, что тот же портал отдаёт имена полей не в той форме, в какой принимает,
 * и на живом портале соседа часть полей из-за этого «не находилась никогда».
 *
 * ⚠ Возвращаются ТОЛЬКО имена полей — они описывают схему смарт-процесса, а не клиента
 * портала, и попасть в журнал им можно. Значения не возвращаются ни в каком виде:
 * идентификатор сделки указывает на конкретного клиента, и в журнале ему места нет.
 */
export function parentFieldNames(response: unknown): string[] {
  const item = (response as { result?: { item?: Record<string, unknown> } } | null)?.result?.item
  if (item === undefined || item === null) return []
  return Object.keys(item).filter(key => key.toLowerCase().includes('parent')).sort()
}

/**
 * Ответственный за элемент «Опрос» — он же тот, кто выпускал ссылку.
 *
 * ⚠ Берём с ЭЛЕМЕНТА, а не со сделки, и не лишним вызовом: элемент мы читаем всё равно,
 * ради связи со сделкой. Ответственный у элемента — это сотрудник, нажавший «выпустить»,
 * то есть ровно тот, кто ждёт ответа. У сделки он может быть другим, и тогда дело
 * досталось бы не тому.
 *
 * Ноль — не прочитали; вызывающий просто не отправит поле.
 */
export function readAssignedById(response: unknown): number {
  const raw = (response as { result?: { item?: Record<string, unknown> } } | null)?.result?.item?.assignedById
  const id = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(id) && id > 0 ? id : 0
}
