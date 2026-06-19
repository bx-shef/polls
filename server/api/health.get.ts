// GET /api/health — liveness/readiness: 200/503 по `store.ping()` (#5), кэш в ядре (анти-DoS).
export default defineEventHandler(async (event) => {
  const api = await useApi()
  const r = await api.health()
  setResponseStatus(event, r.status)
  return r.body
})
