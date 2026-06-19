import {
  npsFor,
  csatFor,
  distributionFor,
  npsTrend,
  byProduct,
  byVersion,
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
 * ⚠️ DEV-ONLY: эндпоинт пока БЕЗ авторизации/rate-limit/tenant-изоляции. Срез по услугам
 * вдобавок раскрывает НАЗВАНИЯ продуктов (CRM-данные портала), фильтр — список версий и n по
 * версии (перебор `?version=N`); всё это закрывает auth — ещё один довод за #47.
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

  // Срез по услугам. Имя берём ПЕРВЫМ вхождением productId (устойчивее к переименованию в
  // CRM, чем «последнее выигрывает»). Ответ с несколькими продуктами учитывается в КАЖДОЙ
  // услуге (срез по услуге, не разбиение — суммы n по услугам могут превышать общий n).
  // Метрику показываем только если её СОБСТВЕННАЯ выборка ≥ порога (не только число ответов
  // услуги) — узкая метрика иначе могла бы деанонимизировать. Услугу без показуемых метрик
  // не выводим. TODO(#49): при SQL-агрегации (PgStore) логика переедет в ядровой helper.
  const productNames = new Map<number, string>()
  for (const r of responses) {
    for (const p of r.context.products ?? []) {
      if (!productNames.has(p.productId)) productNames.set(p.productId, p.productName ?? `#${p.productId}`)
    }
  }
  const services = [...productNames.entries()]
    .map(([productId, name]) => {
      const subset = byProduct(responses, productId)
      const npsSum = npsKey ? npsFor(subset, npsKey) : null
      const csatSum = csatKey ? csatFor(subset, csatKey) : null
      return {
        name,
        n: subset.length,
        nps: npsSum && meetsAnonymity(npsSum.n) ? npsSum.nps : null,
        csat: csatSum && meetsAnonymity(csatSum.n) ? csatSum.mean : null
      }
    })
    .filter((s) => meetsAnonymity(s.n) && (s.nps !== null || s.csat !== null))
    .sort((a, b) => (b.nps ?? -Infinity) - (a.nps ?? -Infinity) || a.name.localeCompare(b.name))

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
