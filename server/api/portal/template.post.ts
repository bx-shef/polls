import { createError, defineEventHandler, readBody } from 'h3'
import { verifyItemAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { hasSchemaField, readTemplateItem } from '../../domain/templates/portal-calls'
import { validateTemplate } from '../../domain/surveys/validate'
import { logger } from '../../utils/logger'
import { positiveInteger } from './-card-owner'
import { openPortalSession } from './-session'

/**
 * Reads one survey template for the builder tab.
 *
 * POST, хотя и читает: фреймовый токен уходит телом, а не адресом — адреса оседают в журналах
 * прокси целиком. Тот же приём, что у соседних портальных роутов.
 *
 * ⚠ ЭЛЕМЕНТ ЧИТАЕТСЯ ТОКЕНОМ СОТРУДНИКА, одним вызовом с проверкой доступа (`verifyItemAccess`), —
 * как у поля «Анкета» и виджета результата. Прежде вкладка читала вызовом приложения:
 * «в «Шаблоне» наши же анкеты, а не данные клиентов». Но номер элемента присылает страница,
 * и с правами администратора любой сотрудник с фреймовым пропуском прочитал бы любую анкету
 * портала, включая черновики, мимо прав CRM на сам элемент. А формулировки анкет бывают
 * внутренними для отдела, и «наши шаблоны» — всё равно тексты сотрудников клиента. Решать,
 * что человеку видно, обязан портал. Панель ревью PR #100 разобрала этот размен у поля «Анкета»,
 * вкладка приведена к тому же (#101).
 *
 * «Не видит» и «удалили» портал не различает: отказ один, `denied`. Видит элемент, но не поле
 * схемы — `hidden-schema`.
 *
 * Последовательность шагов держит `tests/unit/template-read-api.test.ts`.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)
  const body = await readBody<{ itemId?: unknown }>(event).catch(() => null)
  // Тем же разбором, что поля своего типа в той же карточке: пустое — не ноль (`positiveInteger`).
  const itemId = positiveInteger(body?.itemId)
  if (itemId === null) return { ok: false as const, reason: 'no-item' as const }

  const refs = await readStoredRefs(session.call)
  if (refs.template === undefined) {
    // Смарт-процессы создаются при установке. Их отсутствие — незавершённая установка,
    // а не пустой шаблон, и путать эти два состояния в интерфейсе нельзя.
    logger.warn({ domain: session.portal.domain }, 'конструктор: смарт-процесс шаблонов не найден')
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  const access = await verifyItemAccess(session.portal.domain, session.authId, refs.template.entityTypeId, itemId)
  if (!access.ok) {
    if (access.reason === 'unreachable') {
      throw createError({ statusCode: 503, statusMessage: 'Portal unreachable' })
    }
    return { ok: false as const, reason: 'denied' as const }
  }
  // ⚠ Поле схемы портал мог не отдать сотруднику. Показав пустой черновик, мы пригласили бы собрать
  // анкету заново поверх настоящей, которой он не видит (`hasSchemaField`, `/review` в PR #104).
  if (!hasSchemaField(access.item, refs.template)) return { ok: false as const, reason: 'hidden-schema' as const }
  const item = readTemplateItem({ result: { item: access.item } }, refs.template)
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
