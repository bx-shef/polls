import type { CrmContext } from '../domain/schema'
import type { InvitationStore } from '../api/invitation'
import type { IStore } from '../store/types'

/**
 * Оркестрация триггера: «сделка дошла до стадии → создать приглашения на опрос» (ISSUE #17).
 * Ядро, framework-agnostic — стор/стор-приглашений инжектируются, под тестами без портала.
 * Вызывается из хендлера робота/события ПОСЛЕ верификации и `dealToCrmContext`.
 */

/** Из стора нужны только эти два метода — облегчает мок в тестах. */
export type TriggerStore = Pick<IStore, 'surveysTriggeredBy' | 'currentVersion'>

export interface TriggerResult {
  surveyKey: string
  versionNo: number
  /** Токен приглашения — основа ссылки `/s/:surveyKey?token=…` для адресата. */
  token: string
}

/**
 * По стадии сделки (`context.dealStageId`) находит опросы, чья текущая версия триггерится этой
 * стадией (`surveysTriggeredBy`, GIN #22), и создаёт по приглашению на каждый со СНИМКОМ контекста.
 * Возвращает созданные приглашения (токены → ссылки рассылает слой доставки). Идемпотентность
 * «повтор перехода не плодит запись» — на уровне записи ответа (#4, durable по токену); здесь
 * каждый переход выписывает новый токен (один проход опроса = один токен).
 */
export async function handleDealTrigger(deps: {
  store: TriggerStore
  invitations: InvitationStore
  context: CrmContext
  now?: Date
}): Promise<TriggerResult[]> {
  const stageId = deps.context.dealStageId
  if (!stageId) return [] // нет стадии в контексте — триггерить нечего
  const now = deps.now ?? new Date()

  const surveyKeys = await deps.store.surveysTriggeredBy(stageId)
  const results: TriggerResult[] = []
  for (const surveyKey of surveyKeys) {
    const version = await deps.store.currentVersion(surveyKey)
    if (!version) continue // опрос без опубликованной версии — пропускаем
    const inv = deps.invitations.create(
      { surveyKey, versionNo: version.versionNo, context: deps.context },
      now
    )
    results.push({ surveyKey, versionNo: version.versionNo, token: inv.token })
  }
  return results
}

/**
 * Извлекает числовой id сделки из `document_id` робота бизнес-процесса:
 * `['crm','CCrmDocumentDeal','DEAL_759']` → `759`. undefined — не сделка/неразборчиво.
 */
export function dealIdFromDocumentId(documentId: unknown): number | undefined {
  if (!Array.isArray(documentId)) return undefined
  const last = documentId[documentId.length - 1]
  if (typeof last !== 'string') return undefined
  const m = /^DEAL_(\d+)$/.exec(last)
  if (!m) return undefined
  const id = Number(m[1])
  return Number.isInteger(id) && id > 0 ? id : undefined
}
