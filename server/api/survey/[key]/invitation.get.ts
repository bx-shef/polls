// GET /api/survey/:key/invitation?token=… — годна ли ссылка-приглашение, ДО заполнения анкеты.
//
// ⚠️ Отдельный роут, а не параметр к `current.get.ts`, по двум причинам, и обе технические:
//  1. У `current` ответ кэшируется по ETag, посчитанному БЕЗ токена (`sv-<key>-<versionNo>-s<n>`) —
//     токен-зависимое тело отравило бы общий кэш, и один респондент получил бы вердикт другого;
//  2. `current` иммутабелен и кэшируется намеренно, а годность ссылки меняется во времени (истёк
//     срок, кто-то прошёл опрос) — кэшировать её нельзя вовсе.
// Решение и тексты — в ядре (`api.invitationCheck`), здесь только разбор запроса.
import { INVITATION_TOKEN_PARAM, readInvitationToken } from '~core/client/invitation-link'

export default defineEventHandler(async (event) => {
  // Годность меняется во времени — кэшировать нельзя ни клиенту, ни промежуточным узлам. Ставим
  // ДО ветвлений: заголовок, который есть не на всех ответах роута, — это заголовок, про который
  // нельзя рассуждать.
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const api = await useApi()
  const surveyKey = getRouterParam(event, 'key') ?? ''
  // Разбор — общей функцией, а не инлайном: правило («массив отвергается целиком, пробелы срежем»)
  // должно быть одним и тем же у того, кто ссылку собирает, и у того, кто её читает. Инлайн
  // совпадал с ним ровно до первой правки, и ни один тест этого расхождения не поймал бы.
  const token = readInvitationToken(getQuery(event)[INVITATION_TOKEN_PARAM])
  if (token === undefined) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Ссылка неполная — в ней нет кода приглашения. Попросите новую ссылку у менеджера.' }
  }

  const r = await api.invitationCheck({ ip: requestIp(event), surveyKey, token })
  setResponseStatus(event, r.status)
  return r.body
})
