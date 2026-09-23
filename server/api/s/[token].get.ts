import { defineEventHandler, getRouterParam } from 'h3'
import { markOpened } from '../../links/store'
import { resolveSurveyAccess } from './-access'
import { toPublicHeader, toPublicSurvey } from './-view'

/**
 * Serves the public survey page with what it needs to render.
 *
 * Весь путь до анкеты — форма токена, частота, статусная машина, схема — живёт
 * в `resolveSurveyAccess`: он общий с приёмом ответа, и расхождение между двумя копиями
 * заметили бы не раньше, чем оно выстрелит. Здесь остаётся только то, что относится
 * к показу.
 */
export default defineEventHandler(async (event) => {
  const access = await resolveSurveyAccess(event, getRouterParam(event, 'token') ?? '')
  if (!access.ok) return access.body

  // Отмечаем открытие ПОСЛЕ того, как убедились, что показывать есть что: иначе ссылка
  // считалась бы открытой в случае, когда человек увидел ошибку.
  await markOpened(access.link.id)

  return {
    ok: true as const,
    survey: toPublicSurvey(access.template),
    header: toPublicHeader(access.link.header, access.link.createdAt),
  }
})
