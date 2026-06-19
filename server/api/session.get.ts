// GET /api/session — выдаёт nonce + schema_version (анти-replay, #4). Тонкая обёртка
// над ядровым `api.session`; вся логика — в `~core/api`.
export default defineEventHandler(async (event) => {
  const api = await useApi()
  const r = await api.session({ ip: getRequestIP(event) ?? '?' })
  setResponseStatus(event, r.status)
  return r.body
})
