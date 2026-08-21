// POST /api/submit — приём ответа (конвейер honeypot→rate-limit→nonce→версия→валидация→
// invitation — целиком в ядре; сервер ставит СЕРВЕРНЫЕ id/submittedAt).
//
// Body-limit: паритет с src/server/node.ts (64 КБ → 413). Nitro/h3 не ограничивает readBody
// по умолчанию — без этого /api/submit открыт для DoS большим телом. Здешняя проверка срабатывает
// ПЕРВОЙ (общий бэкстоп `server/middleware/body-limit.ts` стоит на 128 КБ — намеренно выше, чтобы
// человек увидел точное «сократите ответ», а не общее «сократите содержимое»); тело без заявленной
// длины (chunked) она пропустила бы как нулевое — этот случай закрывает бэкстоп (411) до
// маршрутизации. Невалидный JSON отвергает сам h3 (400, формат h3 — не ядровой {ok,error});
// это контракт для клиента.
//
// IP по умолчанию — socket; за доверенным reverse-proxy включать xForwardedFor осознанно
// (как в src/server/node.ts), на слое деплоя (#4).
import { submitTenantHint, RATE_LIMIT_MESSAGE } from '~core/api/handlers'

const MAX_BODY_BYTES = 64 * 1024

export default defineEventHandler(async (event) => {
  const len = Number(getRequestHeader(event, 'content-length') ?? 0)
  if (len > MAX_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { ok: false, error: 'Слишком большой объём ответа. Сократите текст и попробуйте снова.' }
  }
  const body = await readBody(event)

  // Портал — ПАРАМЕТР записи (#49). Токен приглашения авторитетен (он глобально уникален и лежит
  // рядом с `portal_id`); без токена обслуживаем, только если ключ опубликован ровно одним порталом.
  // Раньше выбор был на процесс: ответ клиента одного заказчика лёг бы в данные другого — и снаружи
  // это неотличимо от успеха, потому что «ответ принят» отвечают оба случая.
  const hint = submitTenantHint(body)
  const ip = requestIp(event)
  const tenant = await resolvePublicPortal(hint.surveyKey, hint.token, ip)
  if (!tenant.ok && tenant.reason === 'rate') {
    setResponseStatus(event, 429)
    return { ok: false, error: RATE_LIMIT_MESSAGE }
  }
  // ⚠️ Мёртвый токен обслуживаем ОБЫЧНЫМ путём (фолбэк-стор): ссылка не найдена ни у кого, значит
  // вердикт о ней одинаков в любом сторе, а записи не будет — ядро откажет на самом приглашении.
  // Ответить здесь своим отказом значило бы завести второй вердикт о ссылке и соврать человеку,
  // который открыл ровно ту ссылку, которую ему и советуют открыть.
  if (!tenant.ok && !tenant.deadToken) {
    setResponseStatus(event, 404)
    return { ok: false, error: AMBIGUOUS_SUBMIT_MESSAGE }
  }

  const api = await useApiFor(tenant.ok ? tenant.portalId : undefined)
  const r = await api.submit({ ip, body })
  setResponseStatus(event, r.status)
  return r.body
})
