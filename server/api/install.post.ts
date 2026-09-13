import { sql } from 'drizzle-orm'
import { parseBracketForm } from '../b24/event-body'
import { refreshTokens } from '../b24/oauth'
import { decideInstall } from '../domain/portals/install'
import { getDb, isDatabaseConfigured, schema } from '../db/client'
import { b24ClientId, b24ClientSecret } from '../utils/env'
import { encryptSecret } from '../utils/crypto'
import { logger } from '../utils/logger'

/**
 * ONAPPINSTALL handler — a thin adapter over `decideInstall`.
 *
 * В файле сознательно нет ни одной проверки подлинности: они все в доменном слое, потому
 * что обработчик Nitro держится на автоимпорте `defineEventHandler` и не импортируется
 * ни в одном из окружений `vitest`. Всё, что останется здесь, не проверяется ничем.
 * Форма роута взята у `client-bank-alfa-by` (`server/api/b24/events.post.ts`): прочитать
 * сырое тело, разобрать, отдать решателю, применить действие.
 *
 * **Событие не повторяется.** Битрикс24 не пришлёт `ONAPPINSTALL` заново, если обработчик
 * ответил ошибкой. Мы всё равно отвечаем ошибкой на неудачу: администратор увидит, что
 * установка не завершилась, и повторит — это честнее, чем притвориться установленными
 * и молча не работать.
 */
export default defineEventHandler(async (event) => {
  const clientId = b24ClientId()
  const clientSecret = b24ClientSecret()
  if (clientId === '' || clientSecret === '' || !isDatabaseConfigured()) {
    // Без пары приложения подтвердить установку нечем, без базы — сохранять некуда.
    logger.error('установка невозможна: не заданы B24_CLIENT_ID/B24_CLIENT_SECRET или DATABASE_URL')
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  const raw = await readRawBody(event)
  if (typeof raw !== 'string' || raw === '') {
    logger.warn('установка отклонена: пустое тело запроса')
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }

  const decision = await decideInstall(parseBracketForm(raw), {
    reauthorize: refreshToken => refreshTokens({ refreshToken, clientId, clientSecret }),
  })

  if (decision.action === undefined) {
    // Причина — в журнал, наружу только статус: подробный отказ подсказывает подбирающему,
    // какое поле поправить в следующей попытке.
    logger.warn({ reason: decision.reason, status: decision.status }, 'установка не выполнена')
    throw createError({ statusCode: decision.status, statusMessage: 'Install rejected' })
  }

  const portal = decision.action
  const now = new Date()
  await getDb()
    .insert(schema.portals)
    .values({
      memberId: portal.memberId,
      domain: portal.domain,
      accessToken: encryptSecret(portal.accessToken),
      refreshToken: encryptSecret(portal.refreshToken),
      applicationToken: encryptSecret(portal.applicationToken),
      tokenExpiresAt: new Date(now.getTime() + portal.expiresInSeconds * 1000),
      scopes: portal.scope,
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
        accessToken: sql`excluded.access_token`,
        refreshToken: sql`excluded.refresh_token`,
        // Перезаписывается намеренно: при переустановке портал выдаёт новый токен,
        // и сохранённый старый сделал бы непроверяемым каждое следующее событие.
        applicationToken: sql`excluded.application_token`,
        tokenExpiresAt: sql`excluded.token_expires_at`,
        scopes: sql`excluded.scopes`,
        status: sql`excluded.status`,
        updatedAt: sql`excluded.updated_at`,
      },
    })

  logger.info({ domain: portal.domain, reason: decision.reason }, 'портал установлен')
  return { ok: true }
})
