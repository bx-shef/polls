import {
  npsFor,
  csatFor,
  distributionFor,
  npsTrend,
  byProduct,
  meetsAnonymity,
  ANONYMITY_THRESHOLD
} from '~core/domain/aggregate'

/**
 * GET /api/dashboard/:key — агрегаты опроса для дашборда (контур B). Считается СЕРВЕРНО через
 * domain/aggregate над общим стором (useStore — те же ответы, что собирает /api/submit).
 * Вопросы NPS/CSAT/выбор берём по МЕТРИКЕ из текущей версии (не хардкод seed-ключей);
 * распределение отдаём с человекочитаемыми МЕТКАМИ опций (не внутренними ключами).
 * Тренд NPS — помесячно (`npsTrend`, версионно-безопасно по question_key).
 * Срез по услугам — NPS/CSAT по каждому продукту (`byProduct`); имя берём из денормализованного
 * `context.products[].productName`, услуги с выборкой < порога подавляем (анонимность среза).
 *
 * Подавление малых N — ДВА уровня:
 *  1) уровень опроса: при общем n < ANONYMITY_THRESHOLD весь дашборд скрыт
 *     (`meetsAnonymity`, как domain/PgStore — гейт по общему N);
 *  2) уровень точки тренда: месяц с n < ANONYMITY_THRESHOLD отбрасывается внутри
 *     `npsTrend` (параметр `minN`) — тот же порог, но применяется к бакету отдельно.
 * Per-bin k-анонимность распределения — отдельное ужесточение для реальных данных (#49).
 *
 * ⚠️ DEV-ONLY: эндпоинт пока БЕЗ авторизации/rate-limit/tenant-изоляции. Дашборд контура B —
 * внутри Bitrix24 (под OAuth/портал-контекстом); auth-гейтинг + tenant (portalId) → #47,
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

  const responses = await store.listResponses(surveyKey)
  const n = responses.length
  // surveyKey в ответ НЕ зеркалим (клиент знает его из URL; не отражаем недоверенный ввод).
  const base = { ok: true as const, title: version.title, n }

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

  // Срез по услугам: перечисляем уникальные продукты (имя денормализовано в контексте),
  // считаем NPS/CSAT по подвыборке. Услугу с n < порога подавляем (анонимность среза).
  const productNames = new Map<number, string>()
  for (const r of responses) {
    for (const p of r.context.products ?? []) {
      productNames.set(p.productId, p.productName ?? `#${p.productId}`)
    }
  }
  const services = [...productNames.entries()]
    .map(([productId, name]) => {
      const subset = byProduct(responses, productId)
      return {
        name,
        n: subset.length,
        nps: npsKey ? npsFor(subset, npsKey).nps : null,
        csat: csatKey ? csatFor(subset, csatKey).mean : null
      }
    })
    .filter((s) => meetsAnonymity(s.n))
    .sort((a, b) => (b.nps ?? -Infinity) - (a.nps ?? -Infinity))

  return {
    ...base,
    suppressed: false as const,
    nps: npsKey ? npsFor(responses, npsKey) : null,
    csat: csatKey ? csatFor(responses, csatKey) : null,
    distribution,
    // Помесячный тренд NPS; точки с n < порога подавлены (анонимность по месяцу).
    trend: npsKey ? npsTrend(responses, npsKey, 'month', ANONYMITY_THRESHOLD) : [],
    services
  }
})
