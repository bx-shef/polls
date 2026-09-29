import { createError } from 'h3'
import { verifyItemAccess } from '../../b24/frame-auth'
import type { SmartProcessRef } from '../../domain/portals/smart-processes'
import { buildGetTemplateItemCall, isHiddenFromUser, readTemplateItem } from '../../domain/templates/portal-calls'
import type { TemplateItem } from '../../domain/templates/portal-calls'
import { logger } from '../../utils/logger'
import type { PortalSession } from './-session'

/** Шаблон, открытый для конструктора: глазами сотрудника и глазами приложения. */
export type OpenedTemplate
  = | { ok: true, userView: TemplateItem, current: TemplateItem }
    | { ok: false, reason: 'denied' | 'no-item' | 'hidden-fields' }

/**
 * Open one template for the builder: as the employee sees it, checked against the app's view.
 *
 * ⚠ ОДИН ВХОД НА ТРИ РОУТА — чтение, сохранение и публикацию. Первая редакция PR #104 проверяла
 * спрятанную схему в чтении и сохранении, а публикацию забыла, и та выпускала схему, которой
 * сотрудник не видел. Три копии одной проверки расходятся с первой же правки; нашли `/review`
 * и `/code-review`.
 *
 * Порядок несущий:
 * 1. доступ — ТОКЕНОМ СОТРУДНИКА (`verifyItemAccess`): решает портал, и элемент приходит вместе
 *    с ответом. Отказ — `denied` («не видит» и «удалили» портал не различает), недоступность — 503;
 * 2. тот же элемент глазами приложения: по нему сервер решает (неизменяемость, номер версии,
 *    проверка схемы) и им пишет;
 * 3. взгляды сверяются (`isHiddenFromUser`): прячет портал от сотрудника что-то из полей
 *    конструктора — работать с анкетой ему здесь нельзя, отказ `hidden-fields`.
 *
 * Наружу вкладке уходит только `userView`: что сотруднику видно, решает портал (#101).
 */
export async function openTemplate(session: PortalSession, template: SmartProcessRef, itemId: number): Promise<OpenedTemplate> {
  const access = await verifyItemAccess(session.portal.domain, session.authId, template.entityTypeId, itemId)
  if (!access.ok) {
    if (access.reason === 'unreachable') {
      throw createError({ statusCode: 503, statusMessage: 'Portal unreachable' })
    }
    return { ok: false, reason: 'denied' }
  }

  const get = buildGetTemplateItemCall(template, itemId)
  const answer = await session.call(get.method, get.params)
  const current = readTemplateItem(answer, template)
  const userView = readTemplateItem({ result: { item: access.item } }, template)
  if (current === null || userView === null) return { ok: false, reason: 'no-item' }

  // `readTemplateItem` уже убедился, что элемент в ответе есть и это объект.
  const appItem = (answer as { result: { item: Record<string, unknown> } }).result.item
  if (isHiddenFromUser(access.item, appItem, template)) {
    // Сколько и что именно спрятано — не пишем: хватит домена, чтобы найти портал для замера (#88).
    logger.warn({ domain: session.portal.domain }, 'конструктор: поля анкеты не видны сотруднику, работа с ней не пошла')
    return { ok: false, reason: 'hidden-fields' }
  }
  return { ok: true, userView, current }
}
