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
// кто видит сделку. Пускать по нему одному нельзя — и не пускаем.
import { PORTAL_GONE_MESSAGE } from '~core/api/session'
import { parseFrameAuth, verifyFrameAuth } from '~core/bitrix24/frame'
import { buildResultView } from '~core/domain/result-view'
import { errInfo } from '~core/obs/logger'
import { allowB24Session, useB24Authenticator } from '../../utils/b24-session'
import { logger } from '../../utils/api'
import { tenantByMemberId } from '../../utils/tenant'

export default defineEventHandler(async (event) => {
  if (!allowB24Session(requestIp(event))) {
    setResponseStatus(event, 429)
    return { ok: false, error: 'Слишком много запросов. Подождите немного и попробуйте снова.' }
  }

  const body = await readBody(event).catch(() => ({}))
  const responseId = (body as { responseId?: unknown }).responseId
  const frame = parseFrameAuth(body)
  if (!frame || typeof responseId !== 'string' || responseId.trim().length === 0) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Не удалось определить результат. Откройте его кнопкой на деле в карточке сделки.' }
  }

  let portal
  try {
    portal = await verifyFrameAuth(frame, { authenticate: useB24Authenticator() })
  } catch {
    setResponseStatus(event, 401)
    return { ok: false, error: 'Портал не подтверждён. Откройте результат заново из карточки сделки.' }
  }

  try {
    // TENANT (#49): читаем данные ПОДТВЕРЖДЁННОГО портала. Скоуп держит реализация стора — без него
    // менеджер одного заказчика вытащил бы ответ другого перебором id.
    const tenant = await tenantByMemberId(portal.portalId)
    if (!tenant) {
      setResponseStatus(event, 409)
      return { ok: false, error: PORTAL_GONE_MESSAGE }
    }
    const record = await tenant.store.getResponse(responseId.trim())
    // ⚠️ «Нет записи» и «запись чужого портала» отвечают ОДИНАКОВО и намеренно: разница — это ответ
    // на вопрос «а есть ли такой ответ у кого-то ещё», который спрашивающему задавать не положено.
    if (!record) {
      setResponseStatus(event, 404)
      return { ok: false, error: 'Результат не найден. Возможно, данные опроса уже удалены.' }
    }
    // ⚠️ Версия берётся ТА, по которой отвечал клиент, а не текущая: опрос могли переиздать, и
    // страница обязана показывать формулировки, которые человек реально видел. Несовпадение ловит
    // `buildResultView` — он не собирает вид из чужой версии, а не «подставляет что нашлось».
    const version = await tenant.store.getVersion(record.surveyKey, record.versionNo)
    const view = version ? buildResultView(version, record) : undefined
    if (!view) {
      // Версия удалена или не сошлась с записью: показать вопросы нечем, а показывать голые значения
      // без формулировок хуже, чем честно сказать.
      logger.warn('b24_result_no_version', { surveyKey: record.surveyKey, versionNo: record.versionNo })
      setResponseStatus(event, 409)
      return { ok: false, error: 'Опрос этой версии больше не доступен, показать ответы не получится.' }
    }
    logger.info('b24_result_view', { surveyKey: view.surveyKey, versionNo: view.versionNo })
    return { ok: true, view }
  } catch (e) {
    logger.warn('b24_result_fail', { err: errInfo(e) })
    setResponseStatus(event, 502)
    return { ok: false, error: 'Не удалось открыть результат. Попробуйте ещё раз.' }
  }
})
