// POST /api/submit — приём ответа (конвейер honeypot→rate-limit→nonce→версия→валидация→
// invitation — целиком в ядре; сервер ставит СЕРВЕРНЫЕ id/submittedAt).
//
// Body-limit: паритет с src/server/node.ts (64 КБ → 413). Nitro/h3 не ограничивает readBody
// по умолчанию — без этого /api/submit открыт для DoS большим телом. Проверка по
// content-length отсекает обычный случай; потоковый cap для chunked-тел без заголовка —
// слой деплоя/прокси (#4). Невалидный JSON отвергает сам h3 (400, формат h3 — не ядровой
// {ok,error}); это контракт для клиента.
//
// IP по умолчанию — socket; за доверенным reverse-proxy включать xForwardedFor осознанно
// (как в src/server/node.ts), на слое деплоя (#4).
const MAX_BODY_BYTES = 64 * 1024

export default defineEventHandler(async (event) => {
  const len = Number(getRequestHeader(event, 'content-length') ?? 0)
  if (len > MAX_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { ok: false, error: 'Слишком большой запрос' }
  }
  const api = await useApi()
  const body = await readBody(event)
  const r = await api.submit({ ip: getRequestIP(event) ?? '?', body })
  setResponseStatus(event, r.status)
  return r.body
})
