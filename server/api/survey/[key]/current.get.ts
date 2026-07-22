// GET /api/survey/:key/current — публичная проекция текущей версии для рендера контура A
// (#25; БЕЗ `invitationPolicy` — внутренняя CRM-конфигурация наружу не утекает). 404 если
// опроса нет; rate-limited в ядре. HTTP-кэш (#30): иммутабельная версия → ETag `(key@versionNo)` +
// `Cache-Control: no-cache` (клиент ревалидирует; `If-None-Match` совпал → 304, экономит тело).
import { versionETag, etagMatches } from '~core/api/http-cache'

export default defineEventHandler(async (event) => {
  const api = await useApi()
  const surveyKey = getRouterParam(event, 'key') ?? ''
  // Rate-limit/lookup — в ядре (api.survey), ДО кэш-логики: 304 не обходит анти-перебор surveyKey.
  const r = await api.survey({ ip: getRequestIP(event) ?? '?', surveyKey })

  if (r.status === 200) {
    const version = (r.body as { version?: { surveyKey?: string; versionNo?: number } }).version
    if (version?.surveyKey && typeof version.versionNo === 'number') {
      const etag = versionETag(version.surveyKey, version.versionNo)
      setResponseHeader(event, 'ETag', etag)
      // no-cache (не max-age): смена текущей версии (publish) видна сразу, без окна устаревания;
      // экономию даёт условный GET (304 без тела), а не отданный клиенту TTL.
      setResponseHeader(event, 'Cache-Control', 'no-cache')
      if (etagMatches(getRequestHeader(event, 'if-none-match'), etag)) {
        setResponseStatus(event, 304)
        return null
      }
    }
  }

  setResponseStatus(event, r.status)
  return r.body
})
