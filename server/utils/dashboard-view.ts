import { meetsAnonymity, suppressSmallBins, ANONYMITY_THRESHOLD } from '~core/domain/aggregate'
import { dashboardAuthMessage, PORTAL_GONE_MESSAGE } from '~core/api/session'
import type { PortalSession } from '~core/api/session'
import type { IStore } from '~core/store/types'
// ⚠️ Предел длины ключа берётся из ядра, а не переобъявляется: вторая копия молча разъедется с
// остальными публичными путями, а JSDoc рядом обещает «та же граница».
import { MAX_SURVEY_KEY_LEN } from '~core/api/handlers'
import type { SessionTenant } from './tenant'
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

/** Что роут знает о запросе. */
export interface DashboardInput {
  surveyKey: string
  /** `?version=N` как его отдаёт `getQuery` — скаляр, массив или ничего. */
  version: unknown
}

export type SessionResult =
  | { ok: true; session: PortalSession; devOpen: boolean }
  | { ok: false; status: 401 | 503 }

/** Тот же тип, что отдаёт `resolveSessionPortal` — второй контракт разъехался бы молча. */
export type TenantResult = SessionTenant

export interface DashboardDeps {
  allowPortal(portalId: number | undefined): boolean
  session(): SessionResult
  tenant(session: PortalSession): Promise<TenantResult>
  storeFor(portalId: number | undefined): Promise<IStore>
}

export interface DashboardOutcome {
  status: number
  body: Record<string, unknown>
}

export async function dashboardDecision(
  input: DashboardInput,
  deps: DashboardDeps
): Promise<DashboardOutcome> {
  // 1. Гейт #47: прод без валидной сессии портала → 401/503 (срезы раскрывают имена клиентов и
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

  // 2. Tenant-изоляция (#47): `member_id` подписанной сессии → числовой `portal.id`, которым
  // скоуплен стор. Без этого шага дашборд читал бы портал, выбранный инстансом по умолчанию, — то
  // есть сотрудник одного заказчика видел бы срезы другого, с именами клиентов и ответственных.
  const tenant = await deps.tenant(session.session)
  if (!tenant.ok) return { status: tenant.status, body: { ok: false, error: PORTAL_GONE_MESSAGE } }

  // 3. Потолок по порталу — ПОСЛЕ подтверждения тенанта (ключ подделать нельзя) и ДО чтения
  // ответов: именно чтение и счёт стоят дорого. Пер-IP потолка здесь нет намеренно — разбор в
  // `dashboard-limit.ts`: на SSR-пути его ключ один на все порталы.
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

  // ⚠️ Вопросы-метрики берутся из ТЕКУЩЕЙ версии, а не угадываются хранилищем: версионная
  // безопасность держится на стабильном `question_key`, и решать, какой вопрос считать NPS, — дело
  // схемы опроса, а не SQL.
  const npsKey = version.questions.find((q) => q.metric === 'nps')?.key
  const csatKey = version.questions.find((q) => q.metric === 'csat')?.key
  const choiceQ = version.questions.find((q) => q.metric === 'choice')

  // ⚠️ Фильтр по версии (?version=N) принимаем ТОЛЬКО скаляр-строкой и только целым числом; чужое
  // значение игнорируем (все версии). Проверить «а есть ли такая версия» до запроса нечем —
  // `versions` считает само хранилище, — поэтому несуществующая версия даёт пустой срез, а селектор
  // на странице остаётся полным: `versions` берутся ДО фильтра.
  const versionParam = typeof input.version === 'string' ? Number(input.version) : NaN
  const wanted = Number.isInteger(versionParam) ? versionParam : null

  // ⚠️ ОДНО обращение к хранилищу вместо чтения всех ответов в память (#49). Подавление групп,
  // пороги и сортировка — внутри порта, общим кодом для обеих реализаций.
  const metrics = {
    ...(npsKey != null ? { npsKey } : {}),
    ...(csatKey != null ? { csatKey } : {}),
    ...(choiceQ != null ? { choiceKey: choiceQ.key } : {})
  }
  let agg = await store.dashboardAggregates({
    surveyKey: input.surveyKey,
    ...(wanted != null ? { versionNo: wanted } : {}),
    ...metrics
  })

  // ⚠️ Несуществующая версия в адресе игнорируется — показываем ВСЕ версии, а не пустой экран.
  // Второй запрос идёт только на этом пути (кривая ссылка), и он дешевле альтернативы: узнать список
  // версий заранее нельзя, его считает само хранилище, а «просто отдать пусто» превратило бы опечатку
  // в адресе в «данные пропали». `versions` в первом ответе уже полный — он считается ДО фильтра.
  const versionFilter = wanted != null && agg.versions.includes(wanted) ? wanted : null
  if (wanted != null && versionFilter == null) {
    agg = await store.dashboardAggregates({ surveyKey: input.surveyKey, ...metrics })
  }
  const n = agg.n

  // surveyKey в ответ НЕ зеркалим (клиент знает его из URL; не отражаем недоверенный ввод).
  const base = { ok: true as const, title: version.title, n, versions: agg.versions, version: versionFilter }

  if (!meetsAnonymity(n)) {
    return { status: 200, body: { ...base, suppressed: true as const, threshold: ANONYMITY_THRESHOLD } }
  }

  let distribution = null
  if (choiceQ && agg.distribution) {
    const labelByKey = new Map(choiceQ.options.map((o) => [o.key, o.label]))
    const counted = Object.entries(agg.distribution)
      .map(([key, count]) => ({ label: labelByKey.get(key) ?? key, count }))
      .sort((a, b) => b.count - a.count)
    // ⚠️ Подавление ПО ЯЧЕЙКАМ (#49) — второй уровень поверх гейта по общему N, и единственная часть
    // анонимности, которая живёт НЕ в хранилище: сырое распределение нужно и для расчётов, поэтому
    // порт отдаёт счётчики как есть, а прячет их тот, кто показывает их человеку.
    const { items, hiddenBins, hiddenCount } = suppressSmallBins(counted)
    distribution = { question: choiceQ.text, items, hiddenBins, hiddenCount }
  }

  return {
    status: 200,
    body: {
      ...base,
      suppressed: false as const,
      nps: agg.nps,
      csat: agg.csat,
      distribution,
      trend: agg.trend,
      services: agg.services,
      directions: agg.directions,
      responsibles: agg.responsibles,
      clients: agg.clients
    }
  }
}
