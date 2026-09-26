import { defineEventHandler, readBody } from 'h3'
import { readStoredRefs } from '../../b24/provision'
import { buildGetTemplateItemCall, readTemplateItem } from '../../domain/templates/portal-calls'
import { validateTemplate } from '../../domain/surveys/validate'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Reads one survey template for the builder tab.
 *
 * POST, хотя и читает: фреймовый токен уходит телом, а не адресом — адреса оседают в журналах
 * прокси целиком. Тот же приём, что у соседних портальных роутов.
 *
 * ⚠ Элемент читается ВЫЗОВОМ ПРИЛОЖЕНИЯ, а не токеном сотрудника, и это осознанный размен.
 * У приложения прав больше, значит проверка «а можно ли этому человеку сюда» обязана быть
 * нашей. Она есть, и она дешёвая: вкладку открывает сам портал, и открывает он её только
 * тому, кому карточка доступна. Читаем ровно тот элемент, чей идентификатор портал положил
 * во фрейм, — подставить чужой можно, но в этом смарт-процессе лежат наши же шаблоны анкет,
 * а не данные клиентов. Ответы и имена людей живут в другом смарт-процессе, и туда этот
 * роут не ходит.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)
  const body = await readBody<{ itemId?: unknown }>(event).catch(() => null)
  const itemId = Number(body?.itemId)
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return { ok: false as const, reason: 'no-item' as const }
  }

  const refs = await readStoredRefs(session.call)
  if (refs.template === undefined) {
    // Смарт-процессы создаются при установке. Их отсутствие — незавершённая установка,
    // а не пустой шаблон, и путать эти два состояния в интерфейсе нельзя.
    logger.warn({ domain: session.portal.domain }, 'конструктор: смарт-процесс шаблонов не найден')
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const get = buildGetTemplateItemCall(refs.template, itemId)
  const item = readTemplateItem(await session.call(get.method, get.params), refs.template)
  if (item === null) return { ok: false as const, reason: 'no-item' as const }

  // ⚠ Претензии к схеме считает СЕРВЕР, а не вкладка, и это не про удобство: `app/` не имеет
  // права импортировать серверные модули (правило проекта, проверяется скриптом в CI),
  // а проверка живёт в домене — рядом с расчётом баллов, который она и обслуживает.
  // Вторая копия правил в браузере разошлась бы с первой на первой же правке.
  return {
    ok: true as const,
    template: item,
    problems: item.schema === null ? [] : validateTemplate(item.schema),
  }
})
