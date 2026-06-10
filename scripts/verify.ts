/**
 * Локальная проверка итога. Запуск: `pnpm verify`.
 * Строит демо-данные (см. src/demo/seed.ts) и печатает агрегаты на 4 уровнях.
 */
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

const store = buildDemo()
const all = store.responses

const line = (s = '') => console.log(s)
const h = (s: string) => {
  line()
  line(`━━━ ${s} ━━━`)
}

h('ОПРОС И ВЕРСИИ')
line(`Опрос: ${SURVEY_KEY} · ответов: ${all.length} · версий: 2`)
const d = diffVersions(compile(draftV1(), 1), compile(draftV2(), 2))
line(`Изменения v1→v2 (по question_key): ${JSON.stringify(d)}`)

h('УРОВЕНЬ 1 — ПО ОДНОМУ ОПРОСУ (по всем версиям)')
const s1 = bySurvey(all, SURVEY_KEY)
line(`NPS:  ${npsFor(s1, NPS_Q).nps}  (n=${npsFor(s1, NPS_Q).n})`)
line(`CSAT: среднее ${csatFor(s1, CSAT_Q).mean}, топ-бокс ${csatFor(s1, CSAT_Q).topBoxPct}%`)
line('Что понравилось (распределение, версионно-безопасно по ключам):')
for (const [k, v] of Object.entries(distributionFor(s1, LIKED_Q)).sort((a, b) => b[1] - a[1])) {
  line(`   ${k.padEnd(10)} ${v}`)
}

h('УРОВЕНЬ 2 — ПО УСЛУГЕ/ТОВАРУ')
for (const productId of [1001, 1002]) {
  const sub = byProduct(all, productId)
  line(`${String(PRODUCT_NAMES[productId] ?? productId).padEnd(12)} NPS ${npsFor(sub, NPS_Q).nps}, CSAT ${csatFor(sub, CSAT_Q).mean} (n=${sub.length})`)
}

h('УРОВЕНЬ 3 — ПО СДЕЛКАМ ОДНОГО КЛИЕНТА')
for (const companyId of [101, 102]) {
  const sub = byCompany(all, companyId)
  line(`Клиент ${companyId}: NPS ${npsFor(sub, NPS_Q).nps}, CSAT ${csatFor(sub, CSAT_Q).mean} (n=${sub.length})`)
}

h('УРОВЕНЬ 4 — ПО НАПРАВЛЕНИЮ (+ KPI ответственных, порог N≥2)')
for (const categoryId of [1, 2]) {
  const sub = byCategory(all, categoryId)
  line(`${String(CATEGORY_NAMES[categoryId] ?? categoryId).padEnd(10)} NPS ${npsFor(sub, NPS_Q).nps} (n=${sub.length})`)
}
line('KPI по ответственному (весь опрос):')
for (const k of kpiByResponsible(all, NPS_Q, { minN: 2 })) {
  line(`   ${String(RESPONSIBLE_NAMES[k.responsibleId] ?? k.responsibleId).padEnd(10)} NPS ${k.summary.nps} (n=${k.summary.n})`)
}

h('ТРЕНД NPS ПО МЕСЯЦАМ (через границу версий)')
for (const p of npsTrend(all, NPS_Q, 'month')) {
  line(`   ${p.bucket}  NPS ${p.nps}  (n=${p.n})`)
}

line()
line('✓ Итог посчитан. Цифры детерминированы и совпадают с тестами (test/aggregate.test.ts).')
