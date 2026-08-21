// POST /api/b24/result — показать ОДИН ответ менеджеру, открывшему дело-результат в таймлайне (#18).
//
// Конвейер: rate-limit → parseFrameAuth → verifyFrameAuth (SSRF-allowlist → profile → сверка
// member_id) → тенант по подтверждённому порталу → чтение записи ЕГО данных → чистая сборка вида.
//
// ⚠️ **Результат открывается ВНУТРИ портала, а не по публичной ссылке — это решение.** Постановка
// (#18) предлагала `GET /result/:token` с подписанным токеном, и для приглашения такой путь
// правильный: клиент находится СНАРУЖИ портала, иначе он анкету не откроет. У результата аудитория
// обратная — менеджер, который уже внутри. Публичная ссылка была бы вторым, более слабым доступом к
// тем же данным (оценка и свободный текст клиента, снимок сделки), она навсегда осталась бы в теле
// дела и в истории браузера, и отозвать её было бы нечем. Здесь же портал подтверждается тем же
// фрейм-токеном, что и остальные экраны, а запись ищется в данных ИМЕННО этого портала.
//
// ⚠️ Отсюда следствие: `responseId` НЕ секрет. Он лежит в `actionParams` кнопки, то есть виден всем,
// кто видит сделку, а в PgStore это `bigint` — перебор тривиален. Поэтому подтверждённого портала
// МАЛО, и это главный урок ревью: фрейм-токен доказывает портал, но НЕ право сотрудника на сделку.
// Данные мы отдаём из своей базы, значит портал ничего не проверит за нас — проверку надо звать
// самим. Зовём `crm.deal.get` ТОКЕНОМ САМОГО СОТРУДНИКА (как `deal-invite.post.ts`): нет доступа к
// сделке — портал откажет, и мы ответим «не найдено». Без этого рядовой менеджер перебором id читал
// бы свободный текст клиентов по закрытым для него сделкам — а до этой страницы индивидуальный ответ
// вообще нельзя было получить иначе как через дело в таймлайне, то есть под правами CRM.
//
// ⚠️ И второй гейт: опрос, обещавший клиенту анонимность, ставит `resultToTimeline: false`. Дела и
// кнопки для такого опроса не существует — но ЗАПИСЬ существует, и без проверки на чтении перебор
// выдавал бы ровно ту связку «этот клиент ↔ эта сделка ↔ этот текст», ради запрета которой гейт и
// написан. Порог малых выборок сюда не распространяется по построению: тут один респондент.
import { parseFrameAuth, verifyFrameAuth } from '~core/bitrix24/frame'
import { createPortalClient, dealGet, frameToB24Params } from '~core/bitrix24/client'
import { allowB24Session, useB24Authenticator } from '../../utils/b24-session'
import { logger } from '../../utils/api'
import { tenantByMemberId } from '../../utils/tenant'
import { resultViewDecision } from '../../utils/result-view'

export default defineEventHandler(async (event) => {
  // ⚠️ Лимитер стоит ДО разбора и до подтверждения портала — как у соседних b24-роутов. Здесь он
  // нужнее: `verifyFrameAuth` делает исходящий запрос к домену ИЗ ТЕЛА, то есть без лимита роут
  // становится усилителем.
  if (!allowB24Session(requestIp(event))) {
    setResponseStatus(event, 429)
    return { ok: false, error: 'Слишком много запросов. Подождите немного и попробуйте снова.' }
  }

  const body = await readBody(event).catch(() => ({}))
  const frame = parseFrameAuth(body)
  // ⚠️ Роут сам НИЧЕГО не решает: всё решение — в `resultViewDecision`, потому что только там его
  // можно исполнить в тесте. Разбор см. в шапке того модуля.
  const { status, body: out } = await resultViewDecision(
    { frame: frame ?? undefined, responseId: (body as { responseId?: unknown }).responseId },
    {
      verify: (f) => verifyFrameAuth(f, { authenticate: useB24Authenticator() }),
      tenant: (portalId) => tenantByMemberId(portalId),
      // Клиент на токене САМОГО СОТРУДНИКА: права на сделку проверяет портал, а не мы.
      assertDealAccess: async (portal, f, dealId) => {
        const asUser = createPortalClient(
          frameToB24Params({ domain: portal.domain, accessToken: f.AUTH_ID, memberId: portal.portalId }),
          { clientId: process.env.NUXT_B24_CLIENT_ID ?? '', clientSecret: process.env.NUXT_B24_CLIENT_SECRET ?? '' }
        )
        await dealGet(asUser, dealId)
      },
      log: logger
    }
  )
  if (status !== 200) setResponseStatus(event, status)
  return out
})
