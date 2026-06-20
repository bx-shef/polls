import {
  npsFor,
  csatFor,
  distributionFor,
  npsTrend,
  byVersion,
  breakdownBy,
  meetsAnonymity,
  ANONYMITY_THRESHOLD
} from '~core/domain/aggregate'

/**
 * GET /api/dashboard/:key — агрегаты опроса для дашборда (контур B). Считается СЕРВЕРНО через
 * domain/aggregate над общим стором (useStore — те же ответы, что собирает /api/submit).
 * Вопросы NPS/CSAT/выбор берём по МЕТРИКЕ из текущей версии (не хардкод seed-ключей);
 * распределение отдаём с человекочитаемыми МЕТКАМИ опций (не внутренними ключами).
 * Тренд NPS — помесячно (`npsTrend`, версионно-безопасно по question_key).
 * Срезы (услуга/направление/ответственный/клиент) — NPS/CSAT по группам через единый `breakdown`;
 * имена из денормализованных полей контекста (productName/dealCategoryName/responsibleName/
 * companyName), группа с выборкой < порога подавляется (анонимность среза).
 * Фильтр по версии (`?version=N`, `byVersion`) — весь дашборд по одной версии (сравнение
 * «до/после публикации»); `versions` (доступные) считаем ДО фильтра. Метаданные вопросов
 * (ключи/метки) — всегда из ТЕКУЩЕЙ версии (версионно-безопасно по стабильному question_key).
 *
 * Подавление малых N — ДВА уровня:
 *  1) уровень опроса: при общем n < ANONYMITY_THRESHOLD весь дашборд скрыт
 *     (`meetsAnonymity`, как domain/PgStore — гейт по общему N);
 *  2) уровень точки тренда: месяц с n < ANONYMITY_THRESHOLD отбрасывается внутри
 *     `npsTrend` (параметр `minN`) — тот же порог, но применяется к бакету отдельно.
 * Per-bin k-анонимность распределения — отдельное ужесточение для реальных данных (#49).
 *
 * ⚠️ DEV-ONLY: эндпоинт пока БЕЗ авторизации/rate-limit/tenant-изоляции. Срезы раскрывают
 * ИМЕНА из CRM — клиентов (`companyName`) и СОТРУДНИКОВ (`responsibleName` — PII), названия
 * услуг/направлений, плюс список версий (перебор `?version=N`). На синтетическом seed это
 * безвредно, но перед ЛЮБЫМ реальным деплоем обязателен auth-гейт (#47); PII-редакция — #31.
 * Дашборд контура B — внутри Bitrix24 (под OAuth/портал-контекстом); auth-гейтинг + tenant (portalId) → #47,
 * SQL-агрегация (PgStore) + rate-limit → #49. Сейчас данные синтетические (seed), N подавлены.
 */
export default defineEventHandler(async (event) => {
  const surveyKey = getRouterParam(event, 'key') ?? ''
  if (!surveyKey || surveyKey.length > 200) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Некорректный ключ опроса' }
  }

  const store = await useStore()
  const version = await store.currentVersion(surveyKey)
  if (!version) {
    setResponseStatus(event, 404)
    return { ok: false, error: 'Опрос не найден' }
  }

  const allResponses = await store.listResponses(surveyKey)
  // Доступные версии — из ВСЕХ ответов (до фильтра), чтобы селектор не «схлопывался» при срезе.
  const versions = [...new Set(allResponses.map((r) => r.versionNo))].sort((a, b) => a - b)

  // Фильтр по версии (?version=N): сравнение «до/после публикации». `getQuery` может вернуть
  // string|string[]|undefined — принимаем ТОЛЬКО скаляр-строку (массив/повтор не коэрсим).
  // Принимаем лишь СУЩЕСТВУЮЩУЮ версию; невалидное/чужое значение игнорируем (все версии).
  const rawVersion = getQuery(event).version
  const versionParam = typeof rawVersion === 'string' ? Number(rawVersion) : NaN
  const versionFilter = Number.isInteger(versionParam) && versions.includes(versionParam) ? versionParam : null
  const responses = versionFilter != null ? byVersion(allResponses, versionFilter) : allResponses
  const n = responses.length

  // surveyKey в ответ НЕ зеркалим (клиент знает его из URL; не отражаем недоверенный ввод).
  const base = { ok: true as const, title: version.title, n, versions, version: versionFilter }

  if (!meetsAnonymity(n)) {
    return { ...base, suppressed: true as const, threshold: ANONYMITY_THRESHOLD }
  }

  const npsKey = version.questions.find((q) => q.metric === 'nps')?.key
  const csatKey = version.questions.find((q) => q.metric === 'csat')?.key
  const choiceQ = version.questions.find((q) => q.metric === 'choice')

  let distribution = null
  if (choiceQ) {
    const labelByKey = new Map(choiceQ.options.map((o) => [o.key, o.label]))
    const items = Object.entries(distributionFor(responses, choiceQ.key))
      .map(([key, count]) => ({ label: labelByKey.get(key) ?? key, count }))
      .sort((a, b) => b.count - a.count)
    distribution = { question: choiceQ.text, items }
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
})
