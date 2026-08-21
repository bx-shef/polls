import {
  npsFor,
  csatFor,
  distributionFor,
  npsTrend,
  byVersion,
  breakdownBy,
  meetsAnonymity,
  suppressSmallBins,
  ANONYMITY_THRESHOLD
} from '~core/domain/aggregate'
import { dashboardAuthMessage, PORTAL_GONE_MESSAGE } from '~core/api/session'
import type { PortalSession } from '~core/api/session'
import type { IStore } from '~core/store/types'
import { DASHBOARD_RATE_MESSAGE } from './dashboard-limit'

/**
 * Решение роута `/api/dashboard/:key` (#47/#49) — ОТДЕЛЬНО от привязки к Nitro.
 *
 * ⚠️ Вынесено сюда не ради красоты. Порядок проверок здесь и есть защита: лимит стоит до работы,
 * портал берётся ТОЛЬКО из подписанной сессии, тенант подтверждается до выбора стора, а гейт
 * анонимности — до любых цифр. У `server/**` порога покрытия в проекте нет, и ни один греп-гард не
 * отличит «проверка стоит раньше» от «проверка стоит позже»: обе формы содержат одни и те же строки.
 * Тем же приёмом и по той же причине разобраны `invite-issue.ts`, `manual-invite.ts`,
 * `result-view.ts`.
 */

/** Что роут знает о запросе до всякой авторизации. */
export interface DashboardInput {
  ip: string
  surveyKey: string
  /** `?version=N` как его отдаёт `getQuery` — скаляр, массив или ничего. */
  version: unknown
}

export type SessionResult =
  | { ok: true; session: PortalSession; devOpen: boolean }
  | { ok: false; status: 401 | 503 }

export type TenantResult = { ok: true; portalId: number | undefined } | { ok: false; status: 401 }

export interface DashboardDeps {
  allowIp(ip: string): boolean
  allowPortal(portalId: number | undefined): boolean
  session(): SessionResult
  tenant(session: PortalSession): Promise<TenantResult>
  storeFor(portalId: number | undefined): Promise<IStore>
}

export interface DashboardOutcome {
  status: number
  body: Record<string, unknown>
}

/** Ключ опроса приходит из адреса — та же граница длины, что у остальных публичных путей. */
const MAX_SURVEY_KEY_LEN = 200

export async function dashboardDecision(
  input: DashboardInput,
  deps: DashboardDeps
): Promise<DashboardOutcome> {
  // 1. Потолок по адресу — ПЕРВЫМ, до разбора сессии: `resolveSessionPortal` ходит в базу, а адрес
  // дашборда открыт из интернета.
  if (!deps.allowIp(input.ip)) {
    return { status: 429, body: { ok: false, error: DASHBOARD_RATE_MESSAGE } }
  }

  // 2. Гейт #47: прод без валидной сессии портала → 401/503 (срезы раскрывают имена клиентов и
  // сотрудников — fail-closed); dev/гейт — открыто.
  //
  // Отвечаем ТЕЛОМ, а не броском: `createError` Nitro заворачивает в свой конверт, и текст до
  // страницы не доезжает — ей пришлось бы писать свои 401/503, то есть нарушать правило «текст
  // отказа пишет сервер».
  //
  // ⚠️ 503 намеренно НЕ называет переменную окружения: гейт срабатывает раньше проверки ключа,
  // поэтому `/d/что-угодно` открыт любому из интернета — точный доклад «задайте
  // DASHBOARD_AUTH_SECRET» рассказал бы неизвестному, что авторизация дашборда сейчас не работает.
  const session = deps.session()
  if (!session.ok) {
    return { status: session.status, body: { ok: false, error: dashboardAuthMessage(session.status) } }
  }

  // 3. Tenant-изоляция (#47): `member_id` подписанной сессии → числовой `portal.id`, которым
  // скоуплен стор. Без этого шага дашборд читал бы портал, выбранный инстансом по умолчанию, — то
  // есть сотрудник одного заказчика видел бы срезы другого, с именами клиентов и ответственных.
  const tenant = await deps.tenant(session.session)
  if (!tenant.ok) return { status: tenant.status, body: { ok: false, error: PORTAL_GONE_MESSAGE } }

  // 4. Потолок по порталу — ПОСЛЕ подтверждения тенанта (ключ подделать нельзя) и ДО чтения
  // ответов: именно чтение и счёт стоят дорого.
  if (!deps.allowPortal(tenant.portalId)) {
    return { status: 429, body: { ok: false, error: DASHBOARD_RATE_MESSAGE } }
  }

  if (!input.surveyKey || input.surveyKey.length > MAX_SURVEY_KEY_LEN) {
    return { status: 400, body: { ok: false, error: 'Неверный адрес дашборда. Проверьте ссылку.' } }
  }

  const store = await deps.storeFor(tenant.portalId)
  const version = await store.currentVersion(input.surveyKey)
  if (!version) {
    return { status: 404, body: { ok: false, error: 'Опрос не найден. Проверьте адрес.' } }
  }

  const allResponses = await store.listResponses(input.surveyKey)
  // Доступные версии — из ВСЕХ ответов (до фильтра), чтобы селектор не «схлопывался» при срезе.
  const versions = [...new Set(allResponses.map((r) => r.versionNo))].sort((a, b) => a - b)

  // Фильтр по версии (?version=N): сравнение «до/после публикации». `getQuery` может вернуть
  // string|string[]|undefined — принимаем ТОЛЬКО скаляр-строку (массив/повтор не коэрсим).
  // Принимаем лишь СУЩЕСТВУЮЩУЮ версию; невалидное/чужое значение игнорируем (все версии).
  const versionParam = typeof input.version === 'string' ? Number(input.version) : NaN
  const versionFilter = Number.isInteger(versionParam) && versions.includes(versionParam) ? versionParam : null
  const responses = versionFilter != null ? byVersion(allResponses, versionFilter) : allResponses
  const n = responses.length

  // surveyKey в ответ НЕ зеркалим (клиент знает его из URL; не отражаем недоверенный ввод).
  const base = { ok: true as const, title: version.title, n, versions, version: versionFilter }

  if (!meetsAnonymity(n)) {
    return { status: 200, body: { ...base, suppressed: true as const, threshold: ANONYMITY_THRESHOLD } }
  }

  const npsKey = version.questions.find((q) => q.metric === 'nps')?.key
  const csatKey = version.questions.find((q) => q.metric === 'csat')?.key
  const choiceQ = version.questions.find((q) => q.metric === 'choice')

  let distribution = null
  if (choiceQ) {
    const labelByKey = new Map(choiceQ.options.map((o) => [o.key, o.label]))
    const counted = Object.entries(distributionFor(responses, choiceQ.key))
      .map(([key, count]) => ({ label: labelByKey.get(key) ?? key, count }))
      .sort((a, b) => b.count - a.count)
    // ⚠️ Подавление ПО ЯЧЕЙКАМ (#49) — второй уровень поверх гейта по общему N. Гейт по N говорит
    // «выборка достаточна», но внутри достаточной выборки «Отказ от услуги — 1» это один конкретный
    // клиент, а рядом на том же экране лежат срезы по компаниям и ответственным.
    const { items, hiddenBins } = suppressSmallBins(counted)
    distribution = { question: choiceQ.text, items, hiddenBins, threshold: ANONYMITY_THRESHOLD }
  }

  // Срезы по измерениям через ядровой `breakdownBy` (группировка + подавление малых N — там).
  // Имена денормализованы в контексте (productName/dealCategoryName/responsibleName/companyName),
  // фолбэк — внутренний ID вида `#11`. Ответ с несколькими услугами попадает в каждую.
  const opts = { npsKey, csatKey }
  const services = breakdownBy(
    responses,
    (r) => (r.context.products ?? []).map((p) => ({ key: p.productId, name: p.productName ?? `#${p.productId}` })),
    opts
  )
  const directions = breakdownBy(
    responses,
    (r) => (r.context.dealCategoryId != null ? [{ key: r.context.dealCategoryId, name: r.context.dealCategoryName ?? `#${r.context.dealCategoryId}` }] : []),
    opts
  )
  const responsibles = breakdownBy(
    responses,
    (r) => (r.context.responsibleId != null ? [{ key: r.context.responsibleId, name: r.context.responsibleName ?? `#${r.context.responsibleId}` }] : []),
    opts
  )
  const clients = breakdownBy(
    responses,
    (r) => (r.context.companyId != null ? [{ key: r.context.companyId, name: r.context.companyName ?? `#${r.context.companyId}` }] : []),
    opts
  )

  return {
    status: 200,
    body: {
      ...base,
      suppressed: false as const,
      nps: npsKey ? npsFor(responses, npsKey) : null,
      csat: csatKey ? csatFor(responses, csatKey) : null,
      distribution,
      // Помесячный тренд NPS; точки с n < порога подавлены (анонимность по месяцу).
      trend: npsKey ? npsTrend(responses, npsKey, 'month', ANONYMITY_THRESHOLD) : [],
      services,
      directions,
      responsibles,
      clients
    }
  }
}
