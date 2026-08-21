// GET /api/survey/:key/current — публичная проекция текущей версии для рендера контура A
// (#25; БЕЗ `invitationPolicy` — внутренняя CRM-конфигурация наружу не утекает). 404 если
// опроса нет; rate-limited в ядре. HTTP-кэш (#30): иммутабельная версия → ETag
// `sv-p<portalId>-<key>-<versionNo>-s<schemaVersion>` + `Cache-Control: private, no-cache` (клиент
// ревалидирует; `If-None-Match` совпал → 304, экономит тело). Решение — чистая `cacheDecision`
// (под тестами).
import { cacheDecision } from '~core/api/http-cache'
import { RATE_LIMIT_MESSAGE } from '~core/api/handlers'
import { INVITATION_TOKEN_PARAM, readInvitationToken } from '~core/client/invitation-link'

export default defineEventHandler(async (event) => {
  // ⚠️ Ставим ДО ветвлений и потом ужесточаем на 200. Отказ «неоднозначный ключ» зависит от СОСТАВА
  // арендаторов, а не от содержимого: установка постороннего портала переворачивает 200↔404 по тому
  // же адресу, а 404 браузер вправе кэшировать эвристически. Заголовок, которого нет на части
  // ответов роута, — это заголовок, про который нельзя рассуждать.
  setResponseHeader(event, 'Cache-Control', 'private, no-store')

  const surveyKey = getRouterParam(event, 'key') ?? ''

  // Токен — ТОЛЬКО для выбора портала (#49), в содержимое ответа он не входит и годность ссылки
  // здесь не проверяется (это отдельный роут `invitation`, у которого другой кэш и другой вердикт).
  // Без него анкету по ключу, который завели два заказчика, выбрать нечем.
  const token = readInvitationToken(getQuery(event)[INVITATION_TOKEN_PARAM])
  const ip = requestIp(event)
  const tenant = await resolvePublicPortal(surveyKey, token, ip)
  if (!tenant.ok && tenant.reason === 'rate') {
    setResponseStatus(event, 429)
    return { ok: false, error: RATE_LIMIT_MESSAGE }
  }
  if (!tenant.ok) {
    setResponseStatus(event, 404)
    return { ok: false, error: AMBIGUOUS_SURVEY_MESSAGE }
  }

  const api = await useApiFor(tenant.portalId)
  // Анти-перебор `surveyKey` — в ядре (api.survey), ДО кэш-логики: 304 его не обходит. Свой бюджет
  // резолва тенанта отработал выше, до обращения к базе.
  const r = await api.survey({ ip, surveyKey })

  const cache = cacheDecision(r.status, r.body, getRequestHeader(event, 'if-none-match'), tenant.portalId)
  if (cache.etag) {
    setResponseHeader(event, 'ETag', cache.etag)
    // no-cache (не max-age): смена текущей версии (publish) видна сразу, без окна устаревания;
    // экономию даёт условный GET (304 без тела), а не отданный клиенту TTL.
    //
    // ⚠️ `private` — с мультитенанта (#49): у ответа один адрес на все порталы, а тело у них разное.
    // Без этого слова общий кэш (CDN, корпоративный прокси) вправе сохранить анкету одного заказчика
    // и отдать её респонденту другого — ETag он сверит, и тот совпадёт, потому что совпадёт адрес.
    setResponseHeader(event, 'Cache-Control', 'private, no-cache')
  }
  if (cache.notModified) {
    setResponseStatus(event, 304)
    return null
  }

  setResponseStatus(event, r.status)
  return r.body
})
