// GET /api/survey/:key/current — публичная проекция текущей версии для рендера контура A
// (#25; БЕЗ `invitationPolicy` — внутренняя CRM-конфигурация наружу не утекает). 404 если
// опроса нет; rate-limited в ядре. HTTP-кэш (#30): иммутабельная версия → ETag
// `sv-<key>-<versionNo>-s<schemaVersion>` + `Cache-Control: no-cache` (клиент ревалидирует;
// `If-None-Match` совпал → 304, экономит тело). Решение — чистая `cacheDecision` (под тестами).
import { cacheDecision } from '~core/api/http-cache'

export default defineEventHandler(async (event) => {
  const api = await useApi()
  const surveyKey = getRouterParam(event, 'key') ?? ''
  // Rate-limit/lookup — в ядре (api.survey), ДО кэш-логики: 304 не обходит анти-перебор surveyKey.
  const r = await api.survey({ ip: getRequestIP(event) ?? '?', surveyKey })

  const cache = cacheDecision(r.status, r.body, getRequestHeader(event, 'if-none-match'))
  if (cache.etag) {
    setResponseHeader(event, 'ETag', cache.etag)
    // no-cache (не max-age): смена текущей версии (publish) видна сразу, без окна устаревания;
    // экономию даёт условный GET (304 без тела), а не отданный клиенту TTL.
    setResponseHeader(event, 'Cache-Control', 'no-cache')
  }
  if (cache.notModified) {
    setResponseStatus(event, 304)
    return null
  }

  setResponseStatus(event, r.status)
  return r.body
})
