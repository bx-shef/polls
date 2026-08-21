// Ручной запуск опроса из карточки сделки (#176) — Nitro-слой: ядро про REST не знает.
//
// Зачем это вообще. Виджет, открытый из карточки сделки, выписывал приглашение НАПРЯМУЮ: не смотрел,
// не висит ли уже открытое дело-приглашение по этой сделке, и сам дела не создавал. Два следствия:
//  1. **Дубль по нажатию.** Менеджер не заметил блок в таймлайне (или пролистал), открыл виджет из
//     карточки, нажал «Создать ссылку» — у клиента ДВЕ ссылки, и первая умирает, как только он
//     ответит по второй. Ровно тот дефект, от которого мы избавились на автотриггере (#138), только
//     сделанный руками.
//  2. **Невидимость.** Вторая ссылка не появлялась в таймлайне вовсе и в дедупе не участвовала: ни
//     следующее нажатие, ни закрытие при ответе (#177) о ней не знали.
//
// ⚠️ Зависимости внедряются (`manualInvite(input, deps)`), а не резолвятся внутри — тем же приёмом и
// по той же причине, что `invite-issue.ts` и `close-invite.ts`: покрытия у `server/**` нет, и модуль
// с пятью выходами обязан быть исполним в тесте.
import {
  activityConfigurableAdd, buildSurveyInviteActivity, ensureActivityMarker, openInviteActivities
} from '~core/bitrix24/activity'
import { manualInviteMarker } from '~core/bitrix24/invite-delivery'
import { createSurveyInvitation } from '~core/bitrix24/trigger'
import type { PortalClient } from '~core/bitrix24/client'
import type { InvitationStore } from '~core/api/invitation'
import type { IStore } from '~core/store/types'
import type { CrmContext } from '~core/domain/schema'
import { surveyPath } from '~core/client/invitation-link'
import { errInfo } from '~core/obs/logger'

/**
 * Сколько уже висящих дел показываем. Дел на сделке единицы; десяток означает поломку, а не нагрузку
 * (маркер не проставился, и каждое нажатие плодит новое дело).
 */
export const MAX_EXISTING_SHOWN = 10

export interface ManualInviteInput {
  dealId: number
  surveyKey: string
  context: CrmContext
  /**
   * Осознанное «всё равно создать новую ссылку».
   *
   * ⚠️ Кнопка остаётся, и это решение: ручной путь — действие человека, который смотрит на карточку.
   * Запрещать его насовсем неправильно (прошлая ссылка могла уйти не туда, клиент мог её потерять),
   * а вот делать вид, что первой не было, — нельзя.
   */
  force?: boolean
}

export interface ManualInviteDeps {
  /** Клиент портала ПОДТВЕРЖДЁННОГО фрейма — токеном пользователя виджета, как и `crm.deal.get`. */
  client: PortalClient
  store: Pick<IStore, 'currentVersion'>
  invitations: InvitationStore
  /** База абсолютной ссылки (`APP_DOMAIN`/`DOMAIN`); пустая — ссылка выйдет относительной. */
  baseUrl: string
  log: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
  }
  now?: Date
}

export type ManualInviteOutcome =
  /** По этой сделке и опросу уже висит открытое дело-приглашение. Ничего не создано. */
  | { kind: 'existing'; activityIds: number[] }
  /** У опроса нет опубликованной версии — выписывать нечего. */
  | { kind: 'unpublished' }
  /** Приглашение выписано; `activityId` есть, если дело в таймлайне удалось создать. */
  | { kind: 'created'; surveyKey: string; token: string; url: string; activityId?: number }

/**
 * Ручная выписка приглашения по сделке: сначала «уже приглашали?», потом создание.
 *
 * ⚠️ **Ищем по ВЛАДЕЛЬЦУ и коду приложения, а не по маркеру.** Полный маркер собирается из ключа
 * перехода, а ручной путь перехода не подтверждает — его тут просто нет. Зато `openInviteActivities`
 * отвечает ровно на нужный вопрос: «висит ли по этой сделке НАШЕ открытое дело по ЭТОМУ опросу»,
 * причём одинаково видит и автоматические дела, и ручные.
 *
 * ⚠️ **Дело здесь — ЗАПИСЬ, а не канал доставки**, и в этом единственное отличие от автопути. Ссылку
 * менеджер получает в самом виджете, поэтому отказ создания дела НЕ гасит токен: на автопути ссылка
 * без дела недостижима никому, здесь — уже в руках человека. Гасить её значило бы отобрать сделанную
 * работу из-за неудавшейся отметки. Цена честная и записана: без дела следующее нажатие о нём не
 * узнает, поэтому отказ логируется как `warn`.
 */
export async function manualInvite(
  input: ManualInviteInput,
  deps: ManualInviteDeps
): Promise<ManualInviteOutcome> {
  const now = deps.now ?? new Date()
  const { dealId, surveyKey } = input

  if (!input.force) {
    // ⚠️ Отказ поиска — НЕ повод молча выписать вторую ссылку и не повод отказать человеку. Считаем
    // «открытых дел не нашли» и идём создавать: ручной путь начат осознанным действием, и упереть его
    // в недоступность CRM хуже, чем изредка допустить дубль, который менеджер видит своими глазами.
    const open = await openInviteActivities(deps.client, dealId, surveyKey).catch((e: unknown) => {
      deps.log.warn('b24_manual_lookup_fail', { surveyKey, dealId, err: errInfo(e) })
      return [] as number[]
    })
    if (open.length > 0) {
      deps.log.info('b24_manual_dedup', { surveyKey, dealId, found: open.length })
      return { kind: 'existing', activityIds: open.slice(0, MAX_EXISTING_SHOWN) }
    }
  }

  const res = await createSurveyInvitation({
    store: deps.store, invitations: deps.invitations, surveyKey, context: input.context, now
  })
  if (!res) return { kind: 'unpublished' }
  const url = `${deps.baseUrl}${surveyPath(res.surveyKey, res.token)}`

  // ⚠️ Маркер СВОЙ (`manual:<секунды>:<опрос>`), а не `stage:` с выдуманным переходом: подделав ключ
  // перехода, ручное дело начало бы съедать приглашение по настоящему переходу как дубль. Разбор —
  // в `invite-delivery.ts`.
  const marker = manualInviteMarker(Math.floor(now.getTime() / 1000), res.surveyKey)
  try {
    const activityId = await activityConfigurableAdd(deps.client, buildSurveyInviteActivity({
      dealId,
      surveyTitle: res.title,
      surveyKey: res.surveyKey,
      token: res.token,
      surveyUrl: url,
      ...(input.context.responsibleId != null ? { responsibleId: input.context.responsibleId } : {}),
      marker
    }))
    // Та же сверка маркера, что и на автопути: принимает ли `configurable.add` поля маркера, вживую
    // не проверено, а без маркера дело не найдётся ни следующим нажатием, ни закрытием по ответу.
    const markerFix = await ensureActivityMarker(deps.client, activityId, marker).catch(() => 'failed' as const)
    deps.log[markerFix === 'failed' ? 'warn' : 'info']('b24_manual_activity', {
      surveyKey: res.surveyKey, dealId, activityId, markerFix
    })
    return { kind: 'created', surveyKey: res.surveyKey, token: res.token, url, activityId }
  } catch (e) {
    // ⚠️ Токен НЕ гасим — см. разбор в JSDoc. Ссылка уже уходит человеку ответом виджета.
    deps.log.warn('b24_manual_activity_fail', { surveyKey: res.surveyKey, dealId, err: errInfo(e) })
    return { kind: 'created', surveyKey: res.surveyKey, token: res.token, url }
  }
}
