/**
 * Локальная проверка итога. Запуск: `pnpm verify`.
 * Строит демо-данные (см. src/demo/seed.ts), печатает агрегаты на 4 уровнях
 * И СВЕРЯЕТ их через assert — любое расхождение валит процесс (CI ловит регрессию).
 */
import { strict as assert } from 'node:assert'
import {
  bySurvey,
  byProduct,
  byCompany,
  byCategory,
  npsFor,
  csatFor,
  distributionFor,
  kpiByResponsible,
  npsTrend
} from '../src/domain/aggregate'
import { compile, diffVersions } from '../src/domain/compile'
import {
  buildDemo,
  draftV1,
  draftV2,
  SURVEY_KEY,
  NPS_Q,
  CSAT_Q,
  LIKED_Q,
  PRODUCT_NAMES,
  CATEGORY_NAMES,
  RESPONSIBLE_NAMES
} from '../src/demo/seed'

const store = await buildDemo()
const all = await store.listResponses()

const line = (s = '') => console.log(s)
const h = (s: string) => {
  line()
  line(`━━━ ${s} ━━━`)
}

h('ОПРОС И ВЕРСИИ')
line(`Опрос: ${SURVEY_KEY} · ответов: ${all.length} · версий: 2`)
const d = diffVersions(compile(draftV1(), 1), compile(draftV2(), 2))
line(`Изменения v1→v2 (по question_key): ${JSON.stringify(d)}`)
assert.equal(all.length, 12, 'ожидалось 12 ответов')
assert.deepEqual(d, { q_nps: 'unchanged', q_csat: 'text', q_liked: 'options', q_comment: 'unchanged' })

h('УРОВЕНЬ 1 — ПО ОДНОМУ ОПРОСУ (по всем версиям)')
const s1 = bySurvey(all, SURVEY_KEY)
const nps1 = npsFor(s1, NPS_Q)
const csat1 = csatFor(s1, CSAT_Q)
const dist1 = distributionFor(s1, LIKED_Q)
line(`NPS:  ${nps1.nps}  (n=${nps1.n})`)
line(`CSAT: среднее ${csat1.mean}, топ-бокс ${csat1.topBoxPct}%`)
line('Что понравилось (распределение, версионно-безопасно по ключам):')
for (const [k, v] of Object.entries(dist1).sort((a, b) => b[1] - a[1])) {
  line(`   ${k.padEnd(10)} ${v}`)
}
assert.deepEqual({ n: nps1.n, nps: nps1.nps }, { n: 12, nps: 8.3 })
assert.deepEqual({ mean: csat1.mean, top: csat1.topBoxPct }, { mean: 3.67, top: 58.3 })
assert.deepEqual(dist1, { speed: 3, quality: 4, support: 4, price: 2, other: 2, design: 2 })

h('УРОВЕНЬ 2 — ПО УСЛУГЕ/ТОВАРУ')
for (const productId of [1001, 1002]) {
  const sub = byProduct(all, productId)
  line(`${String(PRODUCT_NAMES[productId] ?? productId).padEnd(12)} NPS ${npsFor(sub, NPS_Q).nps}, CSAT ${csatFor(sub, CSAT_Q).mean} (n=${sub.length})`)
}
assert.equal(npsFor(byProduct(all, 1001), NPS_Q).nps, 50)
assert.equal(npsFor(byProduct(all, 1002), NPS_Q).nps, -50)

h('УРОВЕНЬ 3 — ПО СДЕЛКАМ ОДНОГО КЛИЕНТА')
for (const companyId of [101, 102]) {
  const sub = byCompany(all, companyId)
  line(`Клиент ${companyId}: NPS ${npsFor(sub, NPS_Q).nps}, CSAT ${csatFor(sub, CSAT_Q).mean} (n=${sub.length})`)
}
assert.equal(npsFor(byCompany(all, 101), NPS_Q).nps, 66.7)
assert.equal(npsFor(byCompany(all, 102), NPS_Q).nps, -50)

h('УРОВЕНЬ 4 — ПО НАПРАВЛЕНИЮ (+ KPI ответственных, порог N≥2)')
for (const categoryId of [1, 2]) {
  const sub = byCategory(all, categoryId)
  line(`${String(CATEGORY_NAMES[categoryId] ?? categoryId).padEnd(10)} NPS ${npsFor(sub, NPS_Q).nps} (n=${sub.length})`)
}
const kpi = kpiByResponsible(all, NPS_Q, { minN: 2 })
line('KPI по ответственному (весь опрос):')
for (const k of kpi) {
  line(`   ${String(RESPONSIBLE_NAMES[k.responsibleId] ?? k.responsibleId).padEnd(10)} NPS ${k.summary.nps} (n=${k.summary.n})`)
}
assert.equal(npsFor(byCategory(all, 1), NPS_Q).nps, 37.5)
assert.equal(npsFor(byCategory(all, 2), NPS_Q).nps, -50)
assert.deepEqual(kpi.map((k) => [k.responsibleId, k.summary.nps]), [[11, 60], [13, 33.3], [12, -75]])

h('ТРЕНД NPS ПО МЕСЯЦАМ (через границу версий)')
const trend = npsTrend(all, NPS_Q, 'month')
for (const p of trend) {
  line(`   ${p.bucket}  NPS ${p.nps}  (n=${p.n})`)
}
assert.deepEqual(
  trend.map((p) => [p.bucket, p.nps, p.n]),
  [['2026-04', 16.7, 6], ['2026-05', 0, 6]]
)

line()
line('✓ Итог посчитан и СВЕРЕН assert-проверками (совпадает с test/aggregate.test.ts).')
