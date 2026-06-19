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
 * Вопросы NPS/CSAT/выбор берём по МЕТРИКЕ из текущей версии (не хардкод seed-ключей).
 *
 * Подавление малых N: при n < ANONYMITY_THRESHOLD числа НЕ отдаём (анонимность). Это
 * первичный барьер; PgStore-слой делает то же в SQL на чувствительных срезах.
 *
 * ⚠️ DEV-ONLY: эндпоинт пока БЕЗ авторизации. Дашборд контура B — внутри Bitrix24 (под OAuth/
 * портал-контекстом), auth-гейтинг — слой деплоя (#4/#6/#47). Сейчас данные синтетические (seed),
 * малые N подавлены. НЕ выставлять наружу без auth.
 */
export default defineEventHandler(async (event) => {
  const surveyKey = getRouterParam(event, 'key') ?? ''
  const store = await useStore()
  const version = await store.currentVersion(surveyKey)
  if (!version) {
    setResponseStatus(event, 404)
    return { ok: false, error: 'Опрос не найден' }
  }

  const responses = await store.listResponses(surveyKey)
  const n = responses.length
  const base = { ok: true as const, surveyKey, title: version.title, n }

  if (!meetsAnonymity(n)) {
    // Малая выборка — числа скрываем, отдаём только факт подавления и порог.
    return { ...base, suppressed: true as const, threshold: ANONYMITY_THRESHOLD }
  }

  const npsKey = version.questions.find((q) => q.metric === 'nps')?.key
  const csatKey = version.questions.find((q) => q.metric === 'csat')?.key
  const choiceQ = version.questions.find((q) => q.type === 'multi')

  return {
    ...base,
    suppressed: false as const,
    nps: npsKey ? npsFor(responses, npsKey) : null,
    csat: csatKey ? csatFor(responses, csatKey) : null,
    distribution: choiceQ
      ? { question: choiceQ.text, counts: distributionFor(responses, choiceQ.key) }
      : null
  }
})
