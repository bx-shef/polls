// GET /api/survey/:key/invitation?token=… — годна ли ссылка-приглашение, ДО заполнения анкеты.
//
// ⚠️ Отдельный роут, а не параметр к `current.get.ts`, по двум причинам, и обе технические:
//  1. У `current` ответ кэшируется по ETag, посчитанному БЕЗ токена (`sv-<key>-<versionNo>-s<n>`) —
//     токен-зависимое тело отравило бы общий кэш, и один респондент получил бы вердикт другого;
//  2. `current` иммутабелен и кэшируется намеренно, а годность ссылки меняется во времени (истёк
//     срок, кто-то прошёл опрос) — кэшировать её нельзя вовсе.
// Решение и тексты — в ядре (`api.invitationCheck`), здесь только разбор запроса.
import { INVITATION_TOKEN_PARAM } from '~core/client/invitation-link'

export default defineEventHandler(async (event) => {
  const api = await useApi()
  const surveyKey = getRouterParam(event, 'key') ?? ''
  const token = getQuery(event)[INVITATION_TOKEN_PARAM]
  // Массив (`?token=a&token=b`) и пустое значение — не токен. Приводим к строке одним способом с
  // клиентом: имя параметра и правило разбора живут в общем модуле, а не дублируются здесь.
  const raw = typeof token === 'string' ? token.trim() : ''
  if (raw.length === 0) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Ссылка неполная — в ней нет кода приглашения. Попросите новую ссылку у менеджера.' }
  }

  const r = await api.invitationCheck({ ip: requestIp(event), surveyKey, token: raw })
  // Годность меняется во времени — кэшировать нельзя ни клиенту, ни промежуточным узлам.
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, r.status)
  return r.body
})
