import { defineEventHandler } from 'h3'
import { readStoredRefs } from '../../b24/provision'
import { readAllPublishedTemplates } from '../../b24/read-templates'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Lists the surveys a manager may issue a link for.
 *
 * POST, хотя и читает: фреймовый токен уходит телом, а не адресом. Адреса оседают в журналах
 * прокси целиком, и токен сотрудника там не нужен.
 *
 * Пустой список — не ошибка и не поломка. Шаблоны приносит импорт (задачи 5–7) либо конструктор,
 * которого в первых сутках нет вовсе; вкладка обязана объяснить это словами, а не показать
 * пустоту, в которой непонятно, сломалось что-то или так и задумано.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)
  const refs = await readStoredRefs(session.call)

  if (refs.template === undefined) {
    // Смарт-процессы создаются при установке. Их отсутствие означает, что установка
    // не доработала — и это не то, что менеджер должен угадывать по пустому списку.
    logger.warn({ domain: session.portal.domain }, 'вкладка: смарт-процесс шаблонов не найден на портале')
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const surveys = await readAllPublishedTemplates(session.call, refs.template)

  return {
    ok: true as const,
    // Наружу уходит только то, чем выбирают: схему во вкладке показывать незачем,
    // а весит она больше всего остального вместе взятого.
    surveys: surveys.map(s => ({ code: s.code, version: s.version, title: s.title })),
  }
})
