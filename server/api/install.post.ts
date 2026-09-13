import { sql } from 'drizzle-orm'
import { readPortalGrant } from '../domain/portals/grant'
import { nestEventBody } from '../b24/event-payload'
import { refreshTokens } from '../b24/oauth'
import { getDb, isDatabaseConfigured, schema } from '../db/client'
import { b24ClientId, b24ClientSecret } from '../utils/env'
import { sealSecret } from '../utils/crypto'
import { logger } from '../utils/logger'

/**
 * ONAPPINSTALL handler.
 *
 * Адрес открыт в интернет и принимает POST от кого угодно — это свойство механизма событий,
 * а не упущение. Единственное, что отличает настоящую установку от подделки, — это
 * **переавторизация**: мы берём присланный `refresh_token` и меняем его на сервере
 * авторизации своей парой `client_id`/`client_secret`. Сервер отвечает `member_id`,
 * посчитанным на его стороне. Совпал с присланным — грант настоящий. Не совпал — кто-то
 * пытается привязать установку к чужому порталу, и это единственный способ такое поймать.
 *
 * Порядок проверок — от дешёвых к дорогим, и это не стиль: до переавторизации мы не делаем
 * ни одного исходящего запроса, иначе поток мусорных POST превратился бы в поток наших
 * обращений к серверу авторизации.
 *
 * **Событие не повторяется.** Битрикс24 не пришлёт `ONAPPINSTALL` заново, если обработчик
 * ответил ошибкой. Мы всё равно отвечаем ошибкой на неудачу, а не «ок»: администратор
 * увидит, что установка не завершилась, и повторит её — это честнее, чем притвориться
 * установленными и молча не работать.
 */
export default defineEventHandler(async (event) => {
  const body = nestEventBody(await readBody(event).catch(() => null))

  // Один обработчик — одно событие. Всё остальное приедет на `events/[event]`.
  if (String(body.event ?? '').toUpperCase() !== 'ONAPPINSTALL') {
    throw createError({ statusCode: 400, statusMessage: 'Unexpected event' })
  }

  const parsed = readPortalGrant(body.auth)
  if (!parsed.ok) {
    // Причина уходит в лог, наружу — нет: подробный отказ подсказывает подбирающему,
    // какое поле поправить в следующей попытке.
    logger.warn({ reason: parsed.reason }, 'установка отклонена: грант не прошёл проверку состава')
    throw createError({ statusCode: 400, statusMessage: 'Bad grant' })
  }
  const grant = parsed.grant

  const clientId = b24ClientId()
  const clientSecret = b24ClientSecret()
  if (clientId === '' || clientSecret === '') {
    logger.error('установка невозможна: не заданы B24_CLIENT_ID и B24_CLIENT_SECRET')
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }
  if (!isDatabaseConfigured()) {
    logger.error('установка невозможна: нет базы, сохранять токены некуда')
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  const outcome = await refreshTokens({ refreshToken: grant.refreshToken, clientId, clientSecret })
  if (!outcome.ok) {
    // 403 — грант поддельный или мёртвый, повторять нечего. 503 — мы сейчас не можем это
    // выяснить: сеть, таймаут, наша же конфигурация. Разные ответы, потому что разное лечение.
    const status = outcome.kind === 'rejected' ? 403 : 503
    logger.warn({ domain: grant.domain, code: outcome.code, status }, 'установка не прошла переавторизацию')
    throw createError({ statusCode: status, statusMessage: 'Reauthorization failed' })
  }
  const refreshed = outcome.tokens

  // Вот ради этой строки всё и затевалось. Сравнение нормализованное: регистр и пробелы
  // по краям — не различие, а поводов отказать живой установке и так хватает.
  if (refreshed.memberId.toLowerCase() !== grant.memberId.toLowerCase()) {
    logger.error({ domain: grant.domain }, 'установка отклонена: member_id не совпал с переавторизацией')
    throw createError({ statusCode: 403, statusMessage: 'Member mismatch' })
  }

  const db = getDb()
  const now = new Date()
  await db
    .insert(schema.portals)
    .values({
      memberId: grant.memberId,
      domain: grant.domain,
      // ⚠ Пара из переавторизации, а не из события: обмен ВРАЩАЕТ токен, и присланный
      // в событии `refresh_token` после успешного обмена уже мёртв. Сохранив его,
      // мы получили бы отказ при первой же попытке продлить доступ.
      accessToken: sealSecret(refreshed.accessToken),
      refreshToken: sealSecret(refreshed.refreshToken),
      applicationToken: sealSecret(grant.applicationToken),
      tokenExpiresAt: new Date(now.getTime() + refreshed.expiresIn * 1000),
      scopes: refreshed.scope.length > 0 ? refreshed.scope : grant.scope,
      status: 'active',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.portals.memberId,
      // Переустановка на тот же портал — обычное дело: сменилась версия, администратор
      // переставил приложение. Это UPDATE, а не новая запись: иначе к порталу потеряются
      // все привязанные ссылки и буфер.
      set: {
        domain: sql`excluded.domain`,
        // `application_token` перезаписывается намеренно: при переустановке портал выдаёт
        // новый, и сохранённый старый сделал бы непроверяемым каждое следующее событие.
        // У соседнего проекта это поле write-once — там оно единственная защита обработчика;
        // у нас перед записью стоит переавторизация, то есть сюда доходит только настоящий портал.
        accessToken: sql`excluded.access_token`,
        refreshToken: sql`excluded.refresh_token`,
        applicationToken: sql`excluded.application_token`,
        tokenExpiresAt: sql`excluded.token_expires_at`,
        scopes: sql`excluded.scopes`,
        status: sql`excluded.status`,
        updatedAt: sql`excluded.updated_at`,
      },
    })

  logger.info({ domain: grant.domain, scopes: refreshed.scope.length }, 'портал установлен')
  return { ok: true }
})
