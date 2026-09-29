import { defineEventHandler, readBody } from 'h3'
import { readStoredRefs } from '../../b24/provision'
import { validateTemplate } from '../../domain/surveys/validate'
import { logger } from '../../utils/logger'
import { positiveInteger } from './-card-owner'
import { openPortalSession } from './-session'
import { openTemplate } from './-template-access'

/**
 * Reads one survey template for the builder tab.
 *
 * POST, хотя и читает: фреймовый токен уходит телом, а не адресом — адреса оседают в журналах
 * прокси целиком. Тот же приём, что у соседних портальных роутов.
 *
 * ⚠ ВКЛАДКЕ УХОДИТ ЭЛЕМЕНТ ГЛАЗАМИ СОТРУДНИКА — прочитанный его токеном с проверкой доступа
 * (`openTemplate`), как у поля «Анкета» и виджета результата. Прежде вкладка читала вызовом
 * приложения: «в «Шаблоне» наши же анкеты, а не данные клиентов». Но номер элемента присылает
 * страница, и с правами администратора любой сотрудник с фреймовым пропуском прочитал бы любую
 * анкету портала, включая черновики, мимо прав CRM на сам элемент. А формулировки анкет бывают
 * внутренними для отдела, и «наши шаблоны» — всё равно тексты сотрудников клиента. Решать,
 * что человеку видно, обязан портал. Панель ревью PR #100 разобрала этот размен у поля «Анкета»,
 * вкладка приведена к тому же (#101).
 *
 * Вызов приложения здесь остался, но наружу из него не уходит ничего: он нужен, чтобы заметить,
 * что портал прячет от сотрудника поля конструктора (`hidden-fields`), — вход у чтения тот же,
 * что у записи и публикации.
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

  const opened = await openTemplate(session, refs.template, itemId)
  if (!opened.ok) return { ok: false as const, reason: opened.reason }
  const item = opened.userView

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
