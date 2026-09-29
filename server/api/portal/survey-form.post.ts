import { defineEventHandler, readBody } from 'h3'
import { readStoredRefs } from '../../b24/provision'
import type { SurveySection } from '../../domain/surveys/model'
import { buildGetTemplateItemCall, readTemplateItem } from '../../domain/templates/portal-calls'
import { logger } from '../../utils/logger'
import { positiveInteger, readCardOwner, refuseForeignCard } from './-card-owner'
import { openPortalSession } from './-session'

/**
 * Reads one survey template and hands the card field «Анкета» the survey in words (#84, п. 18).
 *
 * ⚠ ЭЛЕМЕНТ ЧИТАЕТСЯ ВЫЗОВОМ ПРИЛОЖЕНИЯ — тот же осознанный размен, что у вкладки конструктора
 * (`template.post.ts`, там же — разбор): в «Шаблоне опроса» лежат наши анкеты, а не данные
 * клиентов, и открывает поле сам портал — тому, кому карточка доступна. Виджет результата, наоборот,
 * читает токеном сотрудника (`survey-result.post.ts`): там ответы клиента.
 *
 * ⚠ ПОЛЕ МОГУТ ЗАВЕСТИ НЕ ТАМ — как и «Результат опроса»: тип виден администратору в списке типов,
 * и без проверки владельца поле на сделке показало бы анкету с номером этой сделки
 * (`refuseForeignCard`, там же — почему это защита от ошибки, а не граница прав).
 *
 * ⚠ В журнал уходит СКОЛЬКО, а не ЧТО: формулировки анкеты — текст сотрудника клиента.
 *
 * Последовательность шагов держит `tests/unit/survey-form-api.test.ts`.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)
  const body = await readBody<{ itemId?: unknown, entityId?: unknown, entityTypeId?: unknown }>(event).catch(() => null)

  const itemId = positiveInteger(body?.itemId)
  if (itemId === null) return { ok: false as const, reason: 'no-item' as const }

  const refs = await readStoredRefs(session.call)
  if (refs.template === undefined) {
    // Установка не доработала — это не то, что человек должен угадывать по пустому полю.
    logger.warn({ domain: session.portal.domain }, 'поле «Анкета»: смарт-процесс шаблонов на портале не найден')
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const refused = refuseForeignCard(readCardOwner(body), refs.template)
  if (refused !== null) return { ok: false as const, reason: refused }

  const get = buildGetTemplateItemCall(refs.template, itemId)
  const item = readTemplateItem(await session.call(get.method, get.params), refs.template)
  if (item === null) return { ok: false as const, reason: 'no-item' as const }

  const sections = (item.schema?.sections ?? []).map(viewOf)
  logger.info(
    { domain: session.portal.domain, sections: sections.length, questions: sections.reduce((sum, section) => sum + section.questions.length, 0) },
    'анкета показана в карточке шаблона',
  )

  return {
    ok: true as const,
    form: {
      code: item.code,
      // Ноль — версии ещё нет: черновик, которого никто не публиковал (`readTemplateItem`).
      version: item.version,
      state: item.state,
      title: item.schema?.title ?? '',
      sections,
    },
  }
})

/**
 * What the field shows of a section: words, not the survey's inner keys and weights.
 *
 * Вес и ключ источника человеку в карточке ни о чём не говорят, а ключ вопроса нужен странице
 * только как ключ строки.
 */
function viewOf(section: SurveySection) {
  return {
    key: section.key,
    title: section.title,
    scored: section.scored,
    questions: section.questions.map(question => ({
      key: question.key,
      title: question.title,
      type: question.type,
      scored: question.scored,
      scale: question.scale ?? null,
    })),
    bands: section.bands.map(band => ({ from: band.from, to: band.to, text: band.text })),
  }
}
