// Решение «показывать ли этот результат и что именно» (#18) — вынесено из роута ЦЕЛИКОМ.
//
// ⚠️ Почему отдельным модулем, а не телом `defineEventHandler`. Пока решение жило в роуте, его
// нельзя было исполнить в тесте вовсе: файл держится на авто-импортах Nitro. Проверка сводилась к
// грепу по исходнику, и ревью показало цену — мутация «в `catch` вокруг `verifyFrameAuth` взять
// портал прямо из тела запроса» проходила ВЕСЬ набор зелёной. То есть анонимный POST с выдуманным
// `member_id` читал бы свободный текст клиентов любого портала, а `pnpm check` этого не видел.
// Тот же приём и по той же причине уже применён в `server/middleware/body-limit.ts` и
// `server/utils/invite-issue.ts`.
//
// ⚠️ Здесь ВОСЕМЬ исходов, и семь из них — отказы. Каждый полностью выключает страницу, и каждый
// обязан быть исполнимым.
import { PORTAL_GONE_MESSAGE } from '~core/api/session'
import type { FrameAuth, VerifiedPortal } from '~core/bitrix24/frame'
import { resultToTimelineEnabled } from '~core/domain/invitation'
import { buildResultView, type ResultView } from '~core/domain/result-view'
import type { IStore } from '~core/store/types'
import { errInfo } from '~core/obs/logger'

/**
 * Кап длины `responseId` — ДО базы.
 *
 * ⚠️ Без него в SQL-параметр уезжала бы строка вплоть до общего бэкстопа тела (128 КБ). Правило то
 * же, что у `resolvePublicPortal`: форма проверяется до обращения к хранилищу, а не после.
 */
export const MAX_RESPONSE_ID_LEN = 64

export interface ResultViewDeps {
  /** Подтвердить портал по фрейм-токену. Бросает — портал НЕ подтверждён. */
  verify: (frame: FrameAuth) => Promise<VerifiedPortal>
  /** Стор портала по подтверждённому `member_id`; `undefined` — приложение удалили. */
  tenant: (portalId: string) => Promise<{ store: Pick<IStore, 'getResponse' | 'getVersion'> } | undefined>
  /**
   * Проверить право САМОГО СОТРУДНИКА на сделку. Бросает — доступа нет.
   *
   * ⚠️ Отдельной зависимостью, а не «сделаем внутри»: это единственная проверка, которую за нас
   * может выполнить только портал, и подменить её в тесте надо уметь.
   */
  assertDealAccess: (portal: VerifiedPortal, frame: FrameAuth, dealId: number) => Promise<void>
  log: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
  }
}

export type ResultViewOutcome =
  | { status: 200; body: { ok: true; view: ResultView } }
  | { status: 400 | 401 | 404 | 409 | 502; body: { ok: false; error: string } }

const NOT_FOUND: ResultViewOutcome = {
  status: 404,
  body: { ok: false, error: 'Результат не найден. Возможно, данные опроса уже удалены.' }
}

/**
 * Решить, что отдать на запрос страницы результата.
 *
 * ⚠️ «Нет записи», «запись чужого портала», «нет доступа к сделке» и «опрос обещал анонимность»
 * отвечают ОДИНАКОВО (404, один текст) и намеренно: разница между ними — ответ на вопрос «а есть ли
 * такой ответ у кого-то ещё», который спрашивающему задавать не положено.
 */
export async function resultViewDecision(
  input: { frame: FrameAuth | undefined; responseId: unknown },
  deps: ResultViewDeps
): Promise<ResultViewOutcome> {
  const { frame } = input
  const raw = input.responseId
  if (
    !frame
    || typeof raw !== 'string'
    || raw.trim().length === 0
    || raw.length > MAX_RESPONSE_ID_LEN
  ) {
    return {
      status: 400,
      body: { ok: false, error: 'Не удалось определить результат. Откройте его кнопкой на деле в карточке сделки.' }
    }
  }
  const responseId = raw.trim()

  let portal: VerifiedPortal
  try {
    portal = await deps.verify(frame)
  } catch {
    // ⚠️ Портал берётся ТОЛЬКО отсюда. Взять его из тела запроса в этой ветке значило бы отдать
    // данные любому анониму — и именно эта мутация раньше проходила весь набор зелёной.
    return {
      status: 401,
      body: { ok: false, error: 'Портал не подтверждён. Откройте результат заново из карточки сделки.' }
    }
  }

  try {
    // TENANT (#49): читаем данные ПОДТВЕРЖДЁННОГО портала. Скоуп держит реализация стора — без него
    // менеджер одного заказчика вытащил бы ответ другого перебором id.
    const tenant = await deps.tenant(portal.portalId)
    if (!tenant) return { status: 409, body: { ok: false, error: PORTAL_GONE_MESSAGE } }

    const record = await tenant.store.getResponse(responseId)
    if (!record) return NOT_FOUND

    // ⚠️ ПРАВА НА СДЕЛКУ — до `getVersion`. Иначе 409 «версия недоступна» стал бы оракулом «такая
    // запись есть, просто не ваша».
    const dealId = record.context.dealId
    // Записи без сделки страницы не имеют по построению: дело-результат создаётся только при `dealId`,
    // а кнопка живёт на деле. Проверять права не на чем — значит и показывать нечего.
    if (dealId === undefined) return NOT_FOUND
    try {
      await deps.assertDealAccess(portal, frame, dealId)
    } catch {
      deps.log.info('b24_result_denied', { portalId: portal.portalId, responseId, dealId })
      return NOT_FOUND
    }

    // ⚠️ Версия берётся ТА, по которой отвечал клиент, а не текущая: опрос могли переиздать, и
    // страница обязана показывать формулировки, которые человек реально видел.
    const version = await tenant.store.getVersion(record.surveyKey, record.versionNo)
    // ⚠️ Гейт анонимности — на ЧТЕНИИ, а не только на записи. Опрос, обещавший «Анонимно», не кладёт
    // результат в карточку; значит и показывать его в контексте сделки нельзя.
    if (version && !resultToTimelineEnabled(version)) {
      deps.log.info('b24_result_anonymous', { surveyKey: record.surveyKey, versionNo: record.versionNo })
      return NOT_FOUND
    }
    const view = version ? buildResultView(version, record) : undefined
    if (!view) {
      // Версия удалена или не сошлась с записью: показать вопросы нечем, а показывать голые значения
      // без формулировок хуже, чем честно сказать.
      deps.log.warn('b24_result_no_version', { surveyKey: record.surveyKey, versionNo: record.versionNo })
      return {
        status: 409,
        body: { ok: false, error: 'Опрос этой версии больше не доступен, показать ответы не получится.' }
      }
    }
    // ⚠️ Чтение индивидуальных ПДн обязано оставлять след: это ПЕРВЫЙ путь такого раскрытия, и при
    // обращении субъекта данных или при разборе инцидента (#31/#10) по логу надо уметь ответить,
    // какой портал и какую запись открывали. Строк ответа в лог не кладём — они и есть те данные.
    deps.log.info('b24_result_view', {
      portalId: portal.portalId,
      responseId,
      dealId,
      surveyKey: view.surveyKey,
      versionNo: view.versionNo
    })
    // ⚠️ Наружу уходит ТОЛЬКО собранный вид. Положи сюда сырую запись — и поимённый срез контекста
    // (`responsibleName` не выводим, #31) обошёлся бы одним словом в возврате.
    return { status: 200, body: { ok: true, view } }
  } catch (e) {
    deps.log.warn('b24_result_fail', { err: errInfo(e) })
    return { status: 502, body: { ok: false, error: 'Не удалось открыть результат. Попробуйте ещё раз.' } }
  }
}
