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
 * Возвращает созданные приглашения (токены → ссылки рассылает слой доставки).
 *
 * ⚠️ **НЕ детектит ПЕРЕХОД стадии.** `ONCRMDEALUPDATE` (event.bind, #17) прилетает на ЛЮБОЙ апдейт сделки
 * (сумма/ответственный/коммент), а не только на смену стадии. Пока сделка стоит на триггер-стадии, каждый
 * её апдейт снова матчит `surveysTriggeredBy` и выписывает НОВЫЙ токен. Сегодня безвредно (слой доставки
 * не подключён, `MemoryInvitationStore`), но **ДО подключения доставки ОБЯЗАТЕЛЕН дедуп** по
 * `(dealId, surveyKey, stage)` (или сравнение прошлой стадии), иначе клиент получит по ссылке на каждое
 * редактирование выигранной сделки. Идемпотентность записи ОТВЕТА (#4, durable по токену) — про другое
 * (не выписывать один токен дважды), тут проблема на уровне ВЫПИСКИ приглашений.
 *
 * ИНВАРИАНТЫ слоя связки (ядро их НЕ обеспечивает — как SSRF-allowlist в oauth.ts):
 *  1. **Tenant-изоляция:** `store` ОБЯЗАН быть scoped на АВТОРИТЕТНЫЙ портал события (PgStore по
 *     `portalId`, полученному из `auth.member_id`, не из POST). Иначе `stageId` одного портала
 *     триггернёт опрос другого (cross-tenant). `surveysTriggeredBy`/`currentVersion` фильтруют по
 *     `portalId` инстанса стора — поэтому передавать сюда нужно стор НУЖНОГО портала.
 *  2. **Анти-форджери:** `context` строится из АВТОРИТЕТНОГО `crm.deal.get` ТОЛЬКО ПОСЛЕ успешной
 *     `verifyApplicationToken` (deal-event.ts). Вызов этой функции без сверки токена = open-trigger.
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

/**
 * Создать приглашение на КОНКРЕТНЫЙ опрос по сделке (ручной запуск из виджета карточки сделки —
 * `CRM_DEAL_DETAIL_ACTIVITY`, охват на всех тарифах). В отличие от `handleDealTrigger` (по стадии),
 * опрос задан явно. Возвращает приглашение или `null`, если у опроса нет опубликованной версии.
 * Tenant-инвариант тот же: `store` ОБЯЗАН быть scoped на портал виджета (см. `handleDealTrigger`).
 */
export async function createSurveyInvitation(deps: {
  store: Pick<IStore, 'currentVersion'>
  invitations: InvitationStore
  surveyKey: string
  context: CrmContext
  now?: Date
}): Promise<TriggerResult | null> {
  const version = await deps.store.currentVersion(deps.surveyKey)
  if (!version) return null
  const inv = deps.invitations.create(
    { surveyKey: deps.surveyKey, versionNo: version.versionNo, context: deps.context },
    deps.now ?? new Date()
  )
  return { surveyKey: deps.surveyKey, versionNo: version.versionNo, token: inv.token }
}
