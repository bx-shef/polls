import type { CrmContext, InvitationPolicy } from '../domain/schema'
import type { InvitationStore } from '../api/invitation'
import type { IStore } from '../store/types'

/**
 * Срок доступности ссылки (`ttlMs` приглашения) из политики версии: `linkTtlSeconds` (сек, [5 мин,
 * 5 дней]) → мс. `undefined` — поле не задано → `create()` падает на дефолт стора (30 дней, back-compat).
 * Диапазон уже провалидирован схемой (`invitationPolicySchema`) на границе compile/PgStore-read.
 */
function linkTtlMs(policy: InvitationPolicy | undefined): number | undefined {
  return policy?.linkTtlSeconds != null ? policy.linkTtlSeconds * 1000 : undefined
}

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

export interface TriggerOutcome {
  /** Выписанные приглашения. */
  created: TriggerResult[]
  /**
   * Опросы, по которым приглашение НЕ выписано, потому что по этому переходу уже приглашали (#138):
   * дело в таймлайне сделки уже висит или цикл уже закрыт ответом. Это и есть отсечённая гроздь.
   *
   * Наружу отдаётся не для полноты: без этого числа в логе живой прогон не отличит «дедуп сработал»
   * от «событие было ровно одно», а увидеть надо именно это.
   */
  deduped: string[]
  /**
   * Опросы, по которым выписка ОТКАЗАЛА (портал недоступен, лимит запросов, нет скоупа).
   *
   * ⚠️ Отдельно от `deduped`, и это не педантизм: «уже приглашали» — штатный исход, «не смогли» —
   * потерянный ответ клиента. Раньше исключение по одному опросу рвало цикл, и остальные опросы той
   * же стадии не получали ничего; Bitrix24 online-события не ретраит, поэтому такой переход терялся
   * навсегда — а в логе это выглядело как одна общая ошибка события без указания, что именно пропало.
   */
  failed: string[]
}

/**
 * Чем выписывается приглашение по ОДНОМУ опросу.
 *
 * Развязка нужна потому, что на разных путях это разная работа. Робот автоматизации просто создаёт
 * приглашение. Событийный путь сначала спрашивает у портала, не висит ли уже дело по этому переходу,
 * и только потом создаёт — приглашение вместе с делом в таймлайне (`invite-delivery.ts`). Ядро про
 * REST ничего не знает и знать не должно, поэтому работа инжектируется.
 *
 * `undefined` — «уже приглашали, ничего не создано»; это штатный исход, а не ошибка.
 */
export type IssueInvitation = (args: {
  surveyKey: string
  /** Человеческий заголовок опроса из ЭТОЙ версии — его видит сотрудник в шапке дела. Берётся
   *  отсюда, а не отдельным чтением: версия уже загружена, а ключ (`csat_postdeal`) в карточке
   *  сделки выглядит служебной строкой, а не названием опроса. */
  title: string
  versionNo: number
  context: CrmContext
  /** Срок жизни ссылки из политики версии (мс); `undefined` — дефолт стора. */
  ttlMs: number | undefined
  now: Date
}) => Promise<TriggerResult | undefined>

/**
 * По стадии сделки (`context.dealStageId`) находит опросы, чья текущая версия триггерится этой
 * стадией (`surveysTriggeredBy`, GIN #22), и создаёт по приглашению на каждый со СНИМКОМ контекста.
 * Возвращает созданные приглашения (токены → ссылки рассылает слой доставки).
 *
 * ⚠️ **Сама эта функция НЕ детектит переход стадии** — она лишь сопоставляет текущую стадию с триггерами.
 * Детекция реального перехода живёт СНАРУЖИ и зависит от пути: событийный путь подтверждает переход историей
 * портала (`stage-transition.ts` → `confirmStageEntry` в `deal-update.ts`), а робот автоматизации вызывается
 * ровно на входе в стадию и в подтверждении не нуждается. Какой путь активен — решает режим (`trigger-mode.ts`).
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
  /**
   * Уже полученный список опросов этой стадии. Событийный путь спрашивает его РАНЬШЕ — дешёвым гейтом
   * перед дорогим REST за историей стадий; без проброса тот же запрос ушёл бы в БД второй раз за одно
   * событие, да ещё и двумя независимыми снимками одного состояния.
   */
  triggeredSurveyKeys?: readonly string[]
  /**
   * Как выписывать приглашение. **Не задана** → просто `invitations.create` (путь робота: он
   * вызывается ровно на входе в стадию, отсекать нечего). Событийный путь передаёт сюда доставку с
   * проверкой дела в таймлайне (#126 + #138).
   */
  issue?: IssueInvitation
  /**
   * Куда сообщить об отказе по ОДНОМУ опросу. Ядро про логгер ничего не знает, но и глотать причину
   * молча нельзя: без неё «приглашение не пришло» неотличимо от «дедуп сработал».
   */
  onIssueError?: (surveyKey: string, error: unknown) => void
}): Promise<TriggerOutcome> {
  const stageId = deps.context.dealStageId
  // нет стадии в контексте — триггерить нечего
  if (!stageId) return { created: [], deduped: [], failed: [] }
  const now = deps.now ?? new Date()

  const surveyKeys = deps.triggeredSurveyKeys ?? (await deps.store.surveysTriggeredBy(stageId))
  const created: TriggerResult[] = []
  const deduped: string[] = []
  const failed: string[] = []
  for (const surveyKey of surveyKeys) {
    const version = await deps.store.currentVersion(surveyKey)
    if (!version) continue // опрос без опубликованной версии — пропускаем
    const args = {
      surveyKey,
      title: version.title,
      versionNo: version.versionNo,
      context: deps.context,
      ttlMs: linkTtlMs(version.invitationPolicy),
      now
    }
    // ⚠️ Отказ ИЗОЛИРОВАН одним опросом. Один переход может запускать несколько опросов, и раньше
    // исключение на первом обрывало цикл: остальные не получали ничего, хотя с ними всё было в
    // порядке. Событие Bitrix24 не ретраит — значит те опросы терялись навсегда.
    try {
      const result = deps.issue
        ? await deps.issue(args)
        : await issueWithoutDedup(deps.invitations, args)
      if (!result) { deduped.push(surveyKey); continue }
      created.push(result)
    } catch (e) {
      failed.push(surveyKey)
      deps.onIssueError?.(surveyKey, e)
    }
  }
  return { created, deduped, failed }
}

/**
 * Выписка БЕЗ дедупа и БЕЗ доставки — фолбэк, когда `issue` не задан (робот, ядровые тесты).
 *
 * ⚠️ Имя выбрано «неудобным» намеренно. Пока фолбэк назывался `defaultIssue`, он читался как
 * «нормальное поведение», а на деле это путь без единой проверки: ни дела в таймлайне, ни маркера,
 * ни защиты от грозди. Новый вход (лид, смарт-процесс) молча унаследовал бы его, и тесты остались бы
 * зелёными — поэтому выбор должен быть виден на месте вызова.
 */
async function issueWithoutDedup(
  invitations: InvitationStore,
  args: { surveyKey: string; versionNo: number; context: CrmContext; ttlMs: number | undefined; now: Date }
): Promise<TriggerResult> {
  const inv = await invitations.create(
    { surveyKey: args.surveyKey, versionNo: args.versionNo, context: args.context, ttlMs: args.ttlMs },
    args.now
  )
  return { surveyKey: args.surveyKey, versionNo: args.versionNo, token: inv.token }
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
  const inv = await deps.invitations.create(
    { surveyKey: deps.surveyKey, versionNo: version.versionNo, context: deps.context, ttlMs: linkTtlMs(version.invitationPolicy) },
    deps.now ?? new Date()
  )
  return { surveyKey: deps.surveyKey, versionNo: version.versionNo, token: inv.token }
}
