import { fetchCrmNames, withCrmNames } from '~core/bitrix24/crm-names'
import type { PortalClient } from '~core/bitrix24/client'
import type { CrmContext } from '~core/domain/schema'
import { errInfo } from '~core/obs/logger'
import { valueByDeadline } from './deadline'

/**
 * Бюджет на три запроса имён, мс.
 *
 * ⚠️ Обогащение стоит НА КРИТИЧЕСКОМ ПУТИ выписки приглашения: событийный роут ждёт всю работу до
 * отдачи 200, а Bitrix24 события не повторяет. Клиент портала отказывает не мгновенно (свой таймаут
 * ~30 секунд, повторы, backoff), поэтому без явного бюджета подтормаживающий справочник съедал бы саму
 * доставку. Не уложились ⇒ выписываем приглашение БЕЗ имён: срез упадёт на `#id` — ровно то, как он
 * работал до этого модуля, — и это несравнимо дешевле, чем не позвать клиента вовсе.
 */
export const CRM_NAMES_DEADLINE_MS = 2000

export interface CrmNamesLog {
  warn: (event: string, fields: Record<string, unknown>) => void
}

/**
 * Снимок CRM + имена для срезов дашборда. Fail-open по построению: любая беда со справочниками
 * оставляет снимок ровно таким, каким он был, и приглашение всё равно уходит.
 *
 * ⚠️ Отказ обязан быть ВИДЕН строкой: молчаливый fail-open здесь неотличим от «обогащение не
 * подключено», а внешне и то и другое выглядит как `#9` в срезе.
 */
export async function enrichWithCrmNames(
  client: PortalClient,
  context: CrmContext,
  log: CrmNamesLog,
  fields: Record<string, unknown> = {}
): Promise<CrmContext> {
  // Спрашивать нечего — все три идентификатора пусты (публичная ссылка без сделки).
  if (context.companyId == null && context.dealCategoryId == null && context.responsibleId == null) {
    return context
  }
  const names = await valueByDeadline(
    fetchCrmNames(client, context).catch((e: unknown) => {
      log.warn('b24_crm_names_fail', { ...fields, reason: 'error', err: errInfo(e) })
      return {}
    }),
    CRM_NAMES_DEADLINE_MS,
    {},
    () => log.warn('b24_crm_names_fail', { ...fields, reason: 'timeout', afterMs: CRM_NAMES_DEADLINE_MS })
  )
  return withCrmNames(context, names)
}
