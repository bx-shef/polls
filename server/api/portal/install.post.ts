import { Buffer } from 'node:buffer'
import { createError, defineEventHandler, getRequestHeader, readRawBody, setResponseHeader, setResponseStatus } from 'h3'
import { makePortalCall } from '../../b24/client'
import { refreshTokens } from '../../b24/oauth'
import { isPortalAdmin } from '../../b24/provision'
import { registerPortal } from '../../b24/register'
import { trustedAddress } from '../../domain/links/rate-limit'
import { readFrameGrant } from '../../domain/portals/grant'
import { decideGrant } from '../../domain/portals/install'
import { isDatabaseConfigured } from '../../db/client'
import { findPortalByMemberId } from '../../links/issue'
import { countAndDecidePortal } from '../../links/rate'
import { b24ClientId, b24ClientSecret } from '../../utils/env'
import { assertEncryptionKey } from '../../utils/crypto'
import { logger } from '../../utils/logger'

/**
 * Installs the app from the setup wizard running inside the portal's iframe.
 *
 * Второй путь установки, и он появился не от хорошей жизни. Тиражное приложение с пунктом
 * в левом меню Битрикс24 считает НЕустановленным, пока страница мастера не вызовет
 * `BX24.installFinish()`. Документация говорит прямо: «Встройки не появятся в интерфейсе,
 * даже если `placement.bind` завершился успешно. События не отправятся на обработчик, даже
 * после успешного `event.bind`». То есть путь через событие `ONAPPINSTALL` в этом режиме
 * не срабатывает вовсе: сервер бы всё создал, портал бы отчитался успехом, а вкладки
 * в сделке не было бы — и причина ненаходима.
 *
 * ⚠ Подлинность доказывается ТЕМ ЖЕ способом, что и у события: переавторизацией гранта
 * на сервере авторизации Битрикс24. Сюда приходит обычный POST, который может отправить кто
 * угодно с чем угодно; единственное, чего подделать нельзя, — работающий `refresh_token`,
 * который обменивается на пару и возвращает `member_id`, посчитанный не нами и не
 * обращающимся. Проверка живёт в `decideGrant` — одна на оба пути, потому что две копии
 * одной проверки со временем начинают проверять разное.
 *
 * ⚠ Но подлинность гранта — это НЕ полномочия. См. `mayReplace` ниже: переавторизация
 * доказывает «сессия настоящая», а не «сессия административная».
 *
 * ⚠ Обмен ВРАЩАЕТ грант: присланный `refresh_token` после него мёртв. Поэтому повторный
 * вызов с тем же телом честно отвечает отказом — это не поломка, а следствие.
 */

/**
 * Предел размера тела.
 *
 * Тот же, что у двух других анонимных POST-роутов (`server/api/install.post.ts`,
 * `server/api/s/[token].post.ts`), и по той же причине: `readBody` буферизует поток в память
 * целиком, до всякой проверки, а Node однопоточный — один анонимный POST с большим телом
 * кладёт обработку у всех порталов сразу. Полезная нагрузка мастера — четыре коротких
 * строки, так что 32 КБ это запас в сотни раз. Нашла панель ревью PR #27: роут приехал
 * без предела, хотя в проекте этот класс атаки уже находили и чинили дважды.
 */
const MAX_BODY_BYTES = 32 * 1024

export default defineEventHandler(async (event) => {
  const clientId = b24ClientId()
  const clientSecret = b24ClientSecret()
  // Тот же порядок, что в обработчике события: ключ шифрования проверяется ДО обмена.
  // Упасть на отсутствующем ключе после обмена значит сжечь единственный грант
  // администратора — повторить мастер он сможет, но только переустановив приложение.
  if (clientId === '' || clientSecret === '' || !isDatabaseConfigured() || !assertEncryptionKey()) {
    logger.error('мастер установки: нет B24_CLIENT_ID/B24_CLIENT_SECRET, DATABASE_URL или B24_TOKEN_ENC_KEY')
    throw createError({ statusCode: 503, statusMessage: 'Not configured' })
  }

  // Заголовок проверяется ДО чтения, факт — после: заголовку верить нельзя, а читать
  // мегабайты, чтобы потом их отвергнуть, значит уже заплатить за атаку.
  const declared = Number(getRequestHeader(event, 'content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Body too large' })
  }
  const raw = await readRawBody(event)
  if (typeof raw !== 'string' || raw === '') {
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Body too large' })
  }

  const body = parseJson(raw) as { auth?: unknown } | null
  const parsed = readFrameGrant(body?.auth)
  if (!parsed.ok) {
    logger.warn({ reason: parsed.reason }, 'мастер установки: грант не разобран')
    throw createError({ statusCode: 400, statusMessage: 'Bad grant' })
  }
  const grant = parsed.grant

  // ⚠ Считаем частоту ДО обмена: каждый запрос сюда — это исходящий вызов к серверу
  // авторизации Битрикс24 от нашего имени, и поток мусорных POST превратился бы в поток
  // наших обращений туда, за который блокируют приложение целиком.
  //
  // У обработчика СОБЫТИЯ (`server/api/install.post.ts`) своего лимита частоты нет, и это
  // решение владельца, записанное в `docs/PROCESS.md`. Периметры разные: адрес обработчика
  // события вписывается в карточку приложения руками и наружу не публикуется, а адрес
  // мастера открывает браузер — он виден в бандле.
  //
  // ⚠ Ключ — ЗАЯВЛЕННЫЙ `member_id`, ещё не подтверждённый. Сначала здесь стояла константа
  // `'install'`, и это был кросс-арендаторский DoS: все порталы мира делили один бюджет
  // в 60 запросов за минуту, то есть шестьдесят одного мусорного POST с одного адреса
  // хватало, чтобы на минуту запереть установку приложения у всех клиентов сразу.
  // Неподтверждённый идентификатор в ключе — тот же уровень доверия, что у `tokenKey`
  // публичных ссылок: подделанное значение бьёт по своему же счётчику, а не по чужому.
  // Нашла панель ревью PR #27.
  const address = trustedAddress(
    getRequestHeader(event, 'x-forwarded-for'),
    event.node.req.socket.remoteAddress ?? '',
  )
  const rate = await countAndDecidePortal(address, grant.memberId)
  if (!rate.allow) {
    logger.warn({ by: rate.by }, 'мастер установки: превышена частота обращений')
    setResponseStatus(event, 429)
    setResponseHeader(event, 'Retry-After', rate.retryAfterSeconds)
    throw createError({ statusCode: 429, statusMessage: 'Too many requests' })
  }

  const decision = await decideGrant(grant, {
    reauthorize: refreshToken => refreshTokens({ refreshToken, clientId, clientSecret }),
  })

  if (decision.action === undefined) {
    // Причина — в журнал, наружу только статус: подробный отказ подсказывает подбирающему,
    // какое поле поправить в следующей попытке.
    logger.warn({ reason: decision.reason, status: decision.status }, 'мастер установки: отказано')
    throw createError({ statusCode: decision.status, statusMessage: 'Install rejected' })
  }

  if (!await mayReplace(decision.action)) {
    logger.warn({ domain: decision.action.domain }, 'мастер установки: не администратор поверх рабочего портала')
    throw createError({ statusCode: 403, statusMessage: 'Admin required' })
  }

  const outcome = await registerPortal(decision.action)
  logger.info({ domain: decision.action.domain, reason: decision.reason, outcome }, 'портал установлен мастером')

  // `provisioned: false` — токены сохранены, смарт-процессы нет. Страница обязана показать
  // это словами, а не завершить установку молча: без смарт-процессов приложение откроется
  // и не сможет ничего, и разбираться будут уже на живом клиенте.
  return { ok: true as const, provisioned: outcome === 'ok' }
})

/**
 * Можно ли этим грантом переписать то, что уже лежит.
 *
 * ⚠ Смысл функции: `getAuthData()` отдаёт `refresh_token` в КАЖДОЙ фреймовой сессии ЛЮБОГО
 * сотрудника уже установленного приложения — проверено в исходнике SDK (`dist/esm/frame/auth.mjs`:
 * `#refreshId = data.REFRESH_ID` ставится при инициализации фрейма и возвращается всегда).
 * То есть грант есть не только у администратора во время установки, а у всех и постоянно.
 *
 * Без этой проверки любой сотрудник, открыв `/install` внутри портала, отправлял бы СВОЙ
 * непривилегированный грант, сервер бы его подтвердил (`member_id` совпадает — портал тот же!)
 * и переписал бы рабочие токены приложения на слабые. Дальше всё, что требует прав
 * администратора, молча ломалось бы у ВСЕГО портала, пока кто-нибудь не заметит и не повторит
 * мастер. Нашла панель ревью PR #27.
 *
 * Проверяем только поверх РАБОЧЕГО портала. Для новой установки и для чиненой после неудачи
 * порядок остаётся прежним — токены пишутся первыми, прав может не хватить, и тогда портал
 * становится `degraded`. Это осознанный компромисс: второй попытки сохранить токены может
 * не быть, а `degraded` виден и чинится повтором мастера.
 */
async function mayReplace(portal: { memberId: string, domain: string, accessToken: string, refreshToken: string, applicationToken: string, expiresInSeconds: number, scope: string[] }): Promise<boolean> {
  const existing = await findPortalByMemberId(portal.memberId)
  if (existing === null || existing.status !== 'active') return true

  try {
    // Спрашиваем НОВЫМ грантом: вопрос ровно в том, административен ли он.
    const call = makePortalCall({
      memberId: portal.memberId,
      domain: portal.domain,
      accessToken: portal.accessToken,
      refreshToken: portal.refreshToken,
      applicationToken: portal.applicationToken,
      expiresIn: portal.expiresInSeconds,
      scope: portal.scope,
    }, async () => {
      // Обновлённые токены тут НЕ сохраняем: мы ещё не решили, можно ли этому гранту
      // трогать запись портала. Сохранить их здесь значило бы сделать ровно то,
      // что функция и должна предотвратить.
    })
    return await isPortalAdmin(call)
  }
  catch (error) {
    // Портал не ответил. Отказываем: пустить непроверенного поверх рабочего портала хуже,
    // чем попросить администратора повторить мастер через минуту.
    logger.warn({ domain: portal.domain, reason: (error as Error).message }, 'мастер установки: права не проверены')
    return false
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch {
    return null
  }
}
