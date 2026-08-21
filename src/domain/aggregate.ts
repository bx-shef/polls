import type { ResponseRecord } from './schema'
import { ces, csat, distribution, nps, type CesSummary, type CsatSummary, type NpsSummary } from './metrics'

/**
 * Агрегация поверх массива ответов. Версионно-безопасна: значения собираются
 * по стабильному question_key, а не по тексту или номеру версии.
 */

/** Минимальный размер выборки для чувствительных срезов (анонимность/значимость). */
export const ANONYMITY_THRESHOLD = 5

/**
 * Достаточна ли выборка, чтобы показать срез без риска деанонимизации.
 * ВНИМАНИЕ: фильтры и метрики ниже — «сырые» building-blocks и НЕ подавляют
 * малые N сами по себе. Принудительное подавление **по общему N** реализует
 * слой чтения: PgStore.aggregateNps/Csat/Distribution (использует этот
 * helper); для in-memory пути вызывайте meetsAnonymity сами.
 * ⚠️ Подавление по ЯЧЕЙКАМ распределения — ОТДЕЛЬНЫЙ вызов (`suppressSmallBins`
 * ниже): ни `distributionFor`, ни `PgStore.aggregateDistribution` его не делают,
 * потому что сырое распределение нужно и для расчётов. Показываете ячейки
 * человеку — зовите.
 */
export function meetsAnonymity(n: number, threshold: number = ANONYMITY_THRESHOLD): boolean {
  return n >= threshold
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, val: V): void {
  const arr = map.get(key)
  if (arr) arr.push(val)
  else map.set(key, [val])
}

function bucketKey(iso: string, bucket: 'month' | 'day'): string {
  // Нормализуем к UTC: offset (напр. +05:00) не должен смещать день/месяц через полночь.
  const utc = new Date(iso).toISOString()
  return bucket === 'month' ? utc.slice(0, 7) : utc.slice(0, 10)
}

/** Числовые значения вопроса по всем ответам (для nps/csat/...). */
export function numericValues(rs: ResponseRecord[], questionKey: string): number[] {
  const out: number[] = []
  for (const r of rs) {
    for (const a of r.answers) {
      if (a.questionKey === questionKey && a.valueNumber != null) out.push(a.valueNumber)
    }
  }
  return out
}

/** Наборы выбранных вариантов вопроса по всем ответам (для распределения). */
export function choiceValues(rs: ResponseRecord[], questionKey: string): string[][] {
  const out: string[][] = []
  for (const r of rs) {
    for (const a of r.answers) {
      if (a.questionKey === questionKey && a.valueChoice.length > 0) out.push(a.valueChoice)
    }
  }
  return out
}

// ── Фильтры под 4 уровня агрегации ──
// ВНИМАНИЕ: сырые срезы НЕ подавляют малые N. Перед показом byCompany/byCategory/
// byProduct проверяйте размер выборки через meetsAnonymity (риск деанонимизации).
export const bySurvey = (rs: ResponseRecord[], surveyKey: string): ResponseRecord[] =>
  rs.filter((r) => r.surveyKey === surveyKey)

export const byCompany = (rs: ResponseRecord[], companyId: number): ResponseRecord[] =>
  rs.filter((r) => r.context.companyId === companyId)

export const byCategory = (rs: ResponseRecord[], categoryId: number): ResponseRecord[] =>
  rs.filter((r) => r.context.dealCategoryId === categoryId)

export const byProduct = (rs: ResponseRecord[], productId: number): ResponseRecord[] =>
  rs.filter((r) => (r.context.products ?? []).some((p) => p.productId === productId))

/** Срез по конкретной версии. */
export const byVersion = (rs: ResponseRecord[], versionNo: number): ResponseRecord[] =>
  rs.filter((r) => r.versionNo === versionNo)

/** Срез по диапазону версий [fromVersion, toVersion] — для сравнения «до/после публикации». */
export const byVersionRange = (rs: ResponseRecord[], fromVersion: number, toVersion: number): ResponseRecord[] =>
  rs.filter((r) => r.versionNo >= fromVersion && r.versionNo <= toVersion)

// ── Метрики по подвыборке ──
export const npsFor = (rs: ResponseRecord[], questionKey: string): NpsSummary =>
  nps(numericValues(rs, questionKey))

export const csatFor = (
  rs: ResponseRecord[],
  questionKey: string,
  opts?: { topBoxMin?: number }
): CsatSummary => csat(numericValues(rs, questionKey), opts)

export const cesFor = (rs: ResponseRecord[], questionKey: string): CesSummary =>
  ces(numericValues(rs, questionKey))

export const distributionFor = (rs: ResponseRecord[], questionKey: string): Record<string, number> =>
  distribution(choiceValues(rs, questionKey))

export interface ResponsibleKpi {
  responsibleId: number
  summary: NpsSummary
}

/** KPI сотрудников: NPS по ответственному с порогом значимости/анонимности. Результат отсортирован по убыванию NPS. */
export function kpiByResponsible(
  rs: ResponseRecord[],
  questionKey: string,
  opts: { minN?: number } = {}
): ResponsibleKpi[] {
  const minN = opts.minN ?? ANONYMITY_THRESHOLD
  const groups = new Map<number, ResponseRecord[]>()
  for (const r of rs) {
    const id = r.context.responsibleId
    if (id == null) continue
    pushTo(groups, id, r)
  }
  const out: ResponsibleKpi[] = []
  for (const [responsibleId, list] of groups) {
    const summary = npsFor(list, questionKey)
    if (meetsAnonymity(summary.n, minN)) out.push({ responsibleId, summary })
  }
  return out.sort((a, b) => b.summary.nps - a.summary.nps)
}

export interface TrendPoint extends NpsSummary {
  bucket: string
}

/**
 * Динамика NPS по периодам (версионно-безопасно — по question_key).
 * Бакеты — UTC: `YYYY-MM` / `YYYY-MM-DD`. `minN` подавляет точки с малой выборкой
 * (по умолчанию 1 — без подавления; для анонимности передайте `ANONYMITY_THRESHOLD`).
 */
export function npsTrend(
  rs: ResponseRecord[],
  questionKey: string,
  bucket: 'month' | 'day' = 'month',
  minN = 1
): TrendPoint[] {
  const groups = new Map<string, number[]>()
  for (const r of rs) {
    for (const a of r.answers) {
      if (a.questionKey === questionKey && a.valueNumber != null) {
        pushTo(groups, bucketKey(r.submittedAt, bucket), a.valueNumber)
      }
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([b, vals]) => ({ bucket: b, ...nps(vals) }))
    .filter((p) => p.n >= minN)
}

/** Строка среза по измерению: имя группы + NPS/CSAT подвыборки (либо `null`, если подавлены). */
export interface BreakdownRow {
  name: string
  /** Число ОТВЕТОВ в группе (не число ответивших на конкретную метрику — те могут быть меньше). */
  n: number
  nps: number | null
  csat: number | null
}

/**
 * Обобщённый срез по измерению (услуга/направление/ответственный/клиент). `pairsOf` достаёт из
 * ответа пары (ключ группы, имя) — МАССИВ, т.к. один ответ может попасть в несколько групп
 * (сделка с двумя услугами); для одиночных измерений — массив из 0–1 элемента. Имя фиксируем
 * ПЕРВЫМ вхождением ключа (устойчиво к переименованию в CRM). Анонимность — ДВА независимых
 * гейта (любой скрывает): группа с числом ответов < `minN` не выводится; метрика обнуляется,
 * если её СОБСТВЕННАЯ выборка < `minN`. Строку без хотя бы одной метрики не выводим (нечего
 * показать + имя не раскрывается без агрегата). Сортировка по NPS убыв., затем по имени.
 */
export function breakdownBy(
  rs: ResponseRecord[],
  pairsOf: (r: ResponseRecord) => Array<{ key: string | number; name: string }>,
  opts: { npsKey?: string; csatKey?: string; minN?: number } = {}
): BreakdownRow[] {
  const groups = new Map<string | number, { name: string; rs: ResponseRecord[] }>()
  for (const r of rs) {
    const seen = new Set<string | number>() // один ответ — не дважды в одну группу (повтор ключа)
    for (const { key, name } of pairsOf(r)) {
      if (seen.has(key)) continue
      seen.add(key)
      const g = groups.get(key)
      if (g) g.rs.push(r)
      else groups.set(key, { name, rs: [r] })
    }
  }
  const raw: RawGroup[] = [...groups.values()].map(({ name, rs: gr }) => ({
    name,
    n: gr.length,
    nps: opts.npsKey ? npsFor(gr, opts.npsKey) : null,
    csat: opts.csatKey ? csatFor(gr, opts.csatKey) : null
  }))
  return finishBreakdown(raw, opts.minN)
}

/**
 * Сырая группа среза ДО подавления: имя, число ответов и обе метрики целиком (с их собственными `n`).
 *
 * Существует затем, чтобы группировку можно было сделать где угодно — в памяти перебором или в
 * PostgreSQL одним `group by`, — а всё остальное осталось ОДНИМ кодом (`finishBreakdown`).
 */
export interface RawGroup {
  name: string
  /** Число ОТВЕТОВ в группе. */
  n: number
  nps: NpsSummary | null
  csat: CsatSummary | null
}

/**
 * Общий «хвост» среза: подавление, отбор и сортировка.
 *
 * ⚠️ Вынесен из `breakdownBy` не ради красоты. Когда дашборд считает срезы в SQL, а демо и тесты — в
 * памяти, любая разница в этих трёх шагах становится расхождением, которое видно только на живом
 * портале с большими данными: подавление в одной реализации на единицу строже, сортировка при
 * равных NPS другая, строка без метрик где-то остаётся. Общий код делает такое расхождение
 * невозможным по построению — различаться может только ГРУППИРОВКА.
 *
 * Анонимность — ДВА независимых гейта (любой скрывает): группа с числом ответов < `minN` не
 * выводится; метрика обнуляется, если её СОБСТВЕННАЯ выборка < `minN`. Строку без хотя бы одной
 * метрики не выводим (нечего показать + имя не раскрывается без агрегата).
 */
export function finishBreakdown(groups: RawGroup[], minN: number = ANONYMITY_THRESHOLD): BreakdownRow[] {
  return groups
    .map((g) => ({
      name: g.name,
      n: g.n,
      nps: g.nps && meetsAnonymity(g.nps.n, minN) ? g.nps.nps : null,
      csat: g.csat && meetsAnonymity(g.csat.n, minN) ? g.csat.mean : null
    }))
    .filter((row) => meetsAnonymity(row.n, minN) && (row.nps !== null || row.csat !== null))
    .sort((a, b) => (b.nps ?? -Infinity) - (a.nps ?? -Infinity) || a.name.localeCompare(b.name, 'ru'))
}

/** Ячейка распределения ответов: человекочитаемая метка варианта и число выборов. */
export interface DistributionBin {
  label: string
  count: number
}

/** Распределение после подавления малых ячеек. */
export interface SuppressedDistribution {
  items: DistributionBin[]
  /** Сколько ячеек скрыто. */
  hiddenBins: number
  /**
   * Сумма скрытых ячеек — публикуется НАМЕРЕННО и является частью защиты, а не утечкой.
   *
   * ⚠️ Пока её не печатали, читатель всё равно вычислял её как `N − Σ показанных` — и это было
   * ХУЖЕ: разность выглядела как находка, а не как опубликованная величина, и никто не отвечал за
   * то, чтобы она оставалась неоднозначной. Теперь остаток объявлен и по построению распадается
   * минимум на две ячейки, ни одна из которых не восстанавливается.
   *
   * `null` — сумму публиковать нельзя: скрытых ячеек меньше двух (сумма назвала бы единственную) либо
   * сама сумма ниже порога и добирать уже нечего (вопрос, на который ответили дважды: «Другие
   * варианты (2): 2» означает по одному ответу в каждой).
   */
  hiddenCount: number | null
}

/**
 * k-анонимность распределения ПО ЯЧЕЙКАМ (#49) — второй уровень поверх гейта по общему N.
 *
 * Зачем отдельно от `meetsAnonymity(n)`. Гейт по общему N говорит «выборка достаточна», но внутри
 * достаточной выборки редкий вариант остаётся точечным: «Отказ от услуги — 1» при 40 ответах это
 * ОДИН конкретный клиент, и на дашборде рядом лежат срезы по компаниям и ответственным. Порог тот
 * же (`ANONYMITY_THRESHOLD`), но применяется к ячейке, как `minN` в `npsTrend` — к точке тренда, а в
 * `breakdownBy` — к группе.
 *
 * ⚠️ **Правило про ОСТАТОК, а не про число ячеек.** Скрыть малые ячейки недостаточно: список
 * вариантов публичен (`GET /api/survey/:key/current` отдаёт метки опций кому угодно с ссылкой), а
 * остаток известен. Скрыли `[1, 1]` при показанных `[10, 8]` — остаток 2 на две ячейки означает «по
 * одной в каждой», то есть оба «конкретных человека» названы. Поэтому прячем самую маленькую из
 * показанных до тех пор, пока скрытых не станет **хотя бы две** И их сумма не достигнет **порога**:
 * только тогда остаток распадается на несколько вариантов и ни одна ячейка не восстанавливается.
 *
 * ⚠️ Первая редакция правила добирала соседнюю ячейку ТОЛЬКО когда скрыта ровно одна. Это закрывало
 * `[20, 7, 1]` и не закрывало `[12, 9, 1, 1]` — выборку из 23 ответов, то есть вполне живую.
 *
 * ⚠️ Итог может оказаться ПУСТЫМ (`[20, 1, 1]`: показать 20 значило бы назвать обе единицы). Пустое
 * распределение — правильный ответ, а не сбой; сумма скрытого при этом печатается, и человек видит,
 * что данные есть, но раздельно не показываются.
 *
 * Порядок входных ячеек сохраняется — сортирует вызывающий. Вход не мутируется.
 */
export function suppressSmallBins(
  items: DistributionBin[],
  minN: number = ANONYMITY_THRESHOLD
): SuppressedDistribution {
  // ⚠️ Пустые ячейки выбрасываем ДО правила: ноль не указывает ни на кого, прятать в нём нечего, а
  // попав в «скрытые», он тянул бы за собой живую соседнюю ячейку (скрытых стало бы одна — сработал
  // бы добор). Сегодня `distributionFor` нулей не создаёт; создаст в тот день, когда захочется
  // печатать ВСЕ варианты вопроса, включая невыбранные. Заодно так же отсеивается `NaN`.
  const real = items.filter((i) => i.count > 0)
  const shown = real.filter((i) => meetsAnonymity(i.count, minN))
  let hiddenBins = real.length - shown.length
  let hiddenCount = real.reduce((a, i) => a + i.count, 0) - shown.reduce((a, i) => a + i.count, 0)

  // Добираем самую маленькую из показанных, пока остаток не станет неоднозначным.
  while (hiddenBins > 0 && (hiddenBins < 2 || hiddenCount < minN) && shown.length > 0) {
    let smallest = 0
    for (let i = 1; i < shown.length; i++) {
      if (shown[i]!.count < shown[smallest]!.count) smallest = i
    }
    hiddenCount += shown[smallest]!.count
    hiddenBins += 1
    shown.splice(smallest, 1)
  }

  // Сумма публикуется, только если она сама проходит порог и распадается минимум на две ячейки.
  // ⚠️ Второе условие не следует из первого: добирать бывает НЕЧЕГО — вопрос, на который ответили
  // дважды («по одному в каждой из двух опций»), цикл выходит по пустому `shown`, а сумма 2 назвала
  // бы обе ячейки. Тогда наружу идёт только число скрытых.
  const publishable = hiddenBins >= 2 && meetsAnonymity(hiddenCount, minN)
  return { items: shown, hiddenBins, hiddenCount: publishable ? hiddenCount : null }
}
