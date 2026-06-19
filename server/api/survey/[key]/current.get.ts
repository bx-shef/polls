// GET /api/survey/:key/current — публичная проекция текущей версии для рендера контура A
// (#25; БЕЗ `invitationPolicy` — внутренняя CRM-конфигурация наружу не утекает). 404 если
// опроса нет; rate-limited в ядре.
export default defineEventHandler(async (event) => {
  const api = await useApi()
  const surveyKey = getRouterParam(event, 'key') ?? ''
  const r = await api.survey({ ip: getRequestIP(event) ?? '?', surveyKey })
  setResponseStatus(event, r.status)
  return r.body
})
