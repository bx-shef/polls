// GET /api/survey/:key/invitation?token=… — годна ли ссылка-приглашение, ДО заполнения анкеты.
//
// ⚠️ Отдельный роут, а не параметр к `current.get.ts`, по двум причинам, и обе технические:
//  1. У `current` ответ кэшируется по ETag, посчитанному БЕЗ токена (`sv-<key>-<versionNo>-s<n>`) —
//     токен-зависимое тело отравило бы общий кэш, и один респондент получил бы вердикт другого;
//  2. `current` иммутабелен и кэшируется намеренно, а годность ссылки меняется во времени (истёк
//     срок, кто-то прошёл опрос) — кэшировать её нельзя вовсе.
// Решение и тексты — в ядре (`api.invitationCheck`), здесь только разбор запроса.
import { INVITATION_TOKEN_PARAM, readInvitationToken } from '~core/client/invitation-link'
import { RATE_LIMIT_MESSAGE } from '~core/api/handlers'

export default defineEventHandler(async (event) => {
  // Годность меняется во времени — кэшировать нельзя ни клиенту, ни промежуточным узлам. Ставим
  // ДО ветвлений: заголовок, который есть не на всех ответах роута, — это заголовок, про который
  // нельзя рассуждать.
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const surveyKey = getRouterParam(event, 'key') ?? ''
  // Разбор — общей функцией, а не инлайном: правило («массив отвергается целиком, пробелы срежем»)
  // должно быть одним и тем же у того, кто ссылку собирает, и у того, кто её читает. Инлайн
  // совпадал с ним ровно до первой правки, и ни один тест этого расхождения не поймал бы.
  const token = readInvitationToken(getQuery(event)[INVITATION_TOKEN_PARAM])
  if (token === undefined) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Ссылка неполная — в ней нет кода приглашения. Попросите новую ссылку у менеджера.' }
  }

  // Портал выбирается ПО ТОКЕНУ (#49): он глобально уникален и лежит рядом с `portal_id`. Без этого
  // проверка шла бы в стор портала, выбранного инстансом по умолчанию, и живая ссылка чужого
  // заказчика читалась бы как мёртвая — «срок истёк или опрос уже пройден» на совершенно исправной.
  const ip = requestIp(event)
  const tenant = await resolvePublicPortal(surveyKey, token, ip)
  if (!tenant.ok && tenant.reason === 'rate') {
    setResponseStatus(event, 429)
    return { ok: false, error: RATE_LIMIT_MESSAGE }
  }
  // ⚠️ Своего отказа «неоднозначный ключ» у этого роута НЕТ, и это не упущение. Токен он требует
  // (без него 400 выше), значит `ok:false` тут означает ровно одно: такого токена нет НИ У КОГО, то
  // есть ссылка мертва глобально и вердикт о ней одинаков в любом сторе. Отвечать своим текстом
  // значило бы (1) соврать человеку, который открыл именно ту ссылку, что ему советуют открыть, и
  // (2) отдать наружу бит «такого токена не существует» — ровно ту утечку, которую ядро закрывало
  // руками, сведя «токен от другого опроса» к общему вердикту.
  const api = await useApiFor(tenant.ok ? tenant.portalId : undefined)
  const r = await api.invitationCheck({ ip, surveyKey, token })
  setResponseStatus(event, r.status)
  return r.body
})
