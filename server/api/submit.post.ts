// POST /api/submit — приём ответа (конвейер анти-абьюза/валидации в ядре). Тело парсит
// Nitro (readBody); невалидный JSON → 400 ещё до ядра. Ядро ставит СЕРВЕРНЫЕ id/submittedAt.
// IP по умолчанию — socket; за доверенным reverse-proxy включать xForwardedFor осознанно
// (как в src/server/node.ts), на слое деплоя (#4).
export default defineEventHandler(async (event) => {
  const api = await useApi()
  const body = await readBody(event)
  const r = await api.submit({ ip: getRequestIP(event) ?? '?', body })
  setResponseStatus(event, r.status)
  return r.body
})
