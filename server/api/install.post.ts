import { Buffer } from 'node:buffer'
import { parseBracketForm } from '../b24/event-body'
import { refreshTokens } from '../b24/oauth'
import { registerPortal } from '../b24/register'
import { decideInstall } from '../domain/portals/install'
import { b24ClientId, b24ClientSecret } from '../utils/env'
import { logger } from '../utils/logger'
import { missingForInstall } from '../utils/readiness'

/**
 * ONAPPINSTALL handler — a thin adapter over `decideInstall`.
 *
 * В файле сознательно нет ни одной проверки подлинности: они все в доменном слое, где
 * проверяются вызовом функции, а не подъёмом сервера с базой. Форма роута взята
 * у `client-bank-alfa-by` (`server/api/b24/events.post.ts`): прочитать сырое тело,
 * разобрать, отдать решателю, применить действие.
 *
 * **Событие, скорее всего, не повторяется — это ДОПУЩЕНИЕ, а не проверенный факт.**
 * Документация `ONAPPINSTALL` про повторы молчит (проверено через `b24-dev-mcp`), живьём
 * это не проверялось, у соседа подтверждения тоже нет — в отличие от фактов про
 * смарт-процессы, где источник указан у каждого. Подтвердить обязана `pnpm verify:install`.
 * Весь порядок здесь рассчитан на худший случай «второго события не будет»: токены
 * сохраняются первыми, обустройство — после и повторяемо. На неудачу отвечаем ошибкой:
 * администратор увидит, что установка не завершилась, и повторит — это честнее, чем
 * притвориться установленными и молча не работать.
 */
/**
 * Предел размера тела.
 *
 * Настоящее событие установки — сотни байт. Замер на ревью: тело в 3,7 МБ с одним ключом
 * вида `a[0][1]…[500000]` разбирается полсекунды и выедает 115 МБ кучи — **до** первой
 * дешёвой проверки. Node однопоточный, поэтому один анонимный POST кладёт обработку
 * у всех порталов сразу. Общий `nginx-proxy` режет тело на своём уровне, но его настройка
 * не наша зона и проверена не была: собственный предел убирает класс атаки целиком
 * и не задевает ни одну настоящую установку.
 */
const MAX_BODY_BYTES = 32 * 1024

export default defineEventHandler(async (event) => {
  const clientId = b24ClientId()
  const clientSecret = b24ClientSecret()
  // ⚠ Ключ шифрования проверяется ЗДЕСЬ, до переавторизации, и это не придирка к порядку.
  // Обмен токена ВРАЩАЕТ грант: присланный `refresh_token` после него мёртв. Упасть на
  // отсутствующем ключе уже после обмена значит сжечь единственный токен администратора,
  // а на повтор события рассчитывать нельзя (см. шапку). Установка стала бы
  // невосстановимой.
  const missing = missingForInstall()
  if (missing.length > 0) {
    // ⚠ Имя виновника, а не список подозреваемых. Раньше здесь перечислялись все четыре
    // причины сразу, и по журналу нельзя было понять, какую переменную править.
    logger.error({ missing }, 'установка невозможна: конфигурация неполна')
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  const raw = await readRawBody(event)
  if (typeof raw !== 'string' || raw === '') {
    logger.warn('установка отклонена: пустое тело запроса')
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    // Границу меряем в байтах, а не в символах: правило проекта, и кириллица весит вдвое.
    logger.warn({ bytes: Buffer.byteLength(raw, 'utf8') }, 'установка отклонена: тело больше предела')
    throw createError({ statusCode: 413, statusMessage: 'Body too large' })
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

  const outcome = await registerPortal(decision.action)

  logger.info({ domain: decision.action.domain, reason: decision.reason, outcome }, 'портал установлен')
  return { ok: true, provisioned: outcome === 'ok' }
})
