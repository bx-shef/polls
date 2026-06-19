import {
  npsFor,
  csatFor,
  distributionFor,
  meetsAnonymity,
  ANONYMITY_THRESHOLD
} from '~core/domain/aggregate'

/**
 * GET /api/dashboard/:key — агрегаты опроса для дашборда (контур B). Считается СЕРВЕРНО через
 * domain/aggregate над общим стором (useStore — те же ответы, что собирает /api/submit).
 * Вопросы NPS/CSAT/выбор берём по МЕТРИКЕ из текущей версии (не хардкод seed-ключей);
 * распределение отдаём с человекочитаемыми МЕТКАМИ опций (не внутренними ключами).
 *
 * Подавление малых N: при n < ANONYMITY_THRESHOLD числа НЕ отдаём (как domain/PgStore —
 * гейт по общему N опроса; per-bin k-анонимность — отдельное ужесточение для реальных данных, #49).
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

  return {
    ...base,
    suppressed: false as const,
    nps: npsKey ? npsFor(responses, npsKey) : null,
    csat: csatKey ? csatFor(responses, csatKey) : null,
    distribution
  }
})
