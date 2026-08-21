import {
  breakdownBy,
  byVersion,
  csatFor,
  distributionFor,
  npsFor,
  npsTrend,
  ANONYMITY_THRESHOLD
} from './aggregate'
import type { ResponseRecord } from './schema'

/**
 * Сборка агрегатов дашборда ИЗ МАССИВА ответов (#49).
 *
 * ⚠️ Это НЕ «дублирующая реализация», а определение контракта: здесь записано, что именно дашборд
 * называет каждым из восьми агрегатов — какие фильтры, какие пороги, какие имена групп. `PgStore`
 * считает то же самое в SQL, а тест паритета (`test/dashboard-aggregates.test.ts`) прогоняет обе
 * реализации по одним данным и сравнивает результат целиком. Разъехаться молча они не могут.
 *
 * ⚠️ Живёт в `domain/`, а не в сторе: чистая функция над записями, без единого обращения наружу.
 * Ею пользуются `MemoryStore` (dev/демо/тесты) и она же — эталон для SQL.
 */
export interface DashboardShape {
  npsKey?: string
  csatKey?: string
  choiceKey?: string
  versionNo?: number
}

/** Имя группы: денормализованное из снимка CRM, фолбэк — внутренний ID вида `#11`. */
const named = (id: number, name: string | undefined): { key: number; name: string } => ({
  key: id,
  name: name ?? `#${id}`
})

/**
 * Пустая выборка — это `null`, а НЕ «метрика со значением 0».
 *
 * ⚠️ Найдено тестом паритета: `npsFor([])` честно отдаёт `{ n: 0, nps: 0 }`, а SQL-вариант на тех же
 * данных отдаёт `null`. До выноса порта разница была невидима — вид не доходил до метрик, пока не
 * прошёл гейт по общему N, — но контракт порта шире вида, и «NPS 0 при нуле ответивших» это ложь, а
 * не число: столько же показал бы опрос, где всех устроило на семёрку.
 */
const orNull = <T extends { n: number }>(s: T | null): T | null => (s && s.n > 0 ? s : null)

/** То же для распределения: ни одной ячейки — `null`. */
const emptyToNull = (d: Record<string, number>): Record<string, number> | null =>
  Object.keys(d).length > 0 ? d : null

export function dashboardFromResponses(all: ResponseRecord[], q: DashboardShape) {
  // Версии — из ВСЕХ ответов (до фильтра), чтобы селектор не «схлопывался» при срезе.
  const versions = [...new Set(all.map((r) => r.versionNo))].sort((a, b) => a - b)
  const responses = q.versionNo != null ? byVersion(all, q.versionNo) : all
  const opts = { npsKey: q.npsKey, csatKey: q.csatKey }

  return {
    n: responses.length,
    versions,
    nps: q.npsKey ? orNull(npsFor(responses, q.npsKey)) : null,
    csat: q.csatKey ? orNull(csatFor(responses, q.csatKey)) : null,
    // Сырые счётчики по `option_key`: метки живут в версии, а k-анонимность ячеек — у потребителя.
    // Пусто ⇒ `null` (не `{}`): «вопрос был, никто не выбрал» и «вопроса нет» вид рисует одинаково,
    // а SQL-вариант пустого объекта не порождает вовсе.
    distribution: q.choiceKey ? emptyToNull(distributionFor(responses, q.choiceKey)) : null,
    // Помесячно; точки с n < порога подавлены (анонимность по месяцу).
    trend: q.npsKey ? npsTrend(responses, q.npsKey, 'month', ANONYMITY_THRESHOLD) : [],
    // Ответ с несколькими услугами попадает в каждую.
    services: breakdownBy(
      responses,
      (r) => (r.context.products ?? []).map((p) => named(p.productId, p.productName)),
      opts
    ),
    directions: breakdownBy(
      responses,
      (r) => (r.context.dealCategoryId != null ? [named(r.context.dealCategoryId, r.context.dealCategoryName)] : []),
      opts
    ),
    responsibles: breakdownBy(
      responses,
      (r) => (r.context.responsibleId != null ? [named(r.context.responsibleId, r.context.responsibleName)] : []),
      opts
    ),
    clients: breakdownBy(
      responses,
      (r) => (r.context.companyId != null ? [named(r.context.companyId, r.context.companyName)] : []),
      opts
    )
  }
}
