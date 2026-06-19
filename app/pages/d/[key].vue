<script setup lang="ts">
// Дашборд результатов (контур B): аналитика опроса в нативной теме b24ui (air-токены, без
// индиго-айдентики контура A). Данные — серверный агрегат /api/dashboard/:key (domain/aggregate
// + подавление малых N; распределение приходит с метками опций). Тонкий рендер. DEV-ONLY (auth → #47).
// Типы метрик — из ядра (type-only: в клиентский бандл не попадают, граница ~core
// соблюдена). Один источник правды с серверным агрегатом — расхождение ловит компилятор.
import type { NpsSummary, CsatSummary } from '~core/domain/metrics'
import type { TrendPoint } from '~core/domain/aggregate'

interface Dashboard {
  ok: boolean
  title?: string
  n?: number
  suppressed?: boolean
  threshold?: number
  nps?: NpsSummary | null
  csat?: CsatSummary | null
  distribution?: { question: string; items: { label: string; count: number }[] } | null
  trend?: TrendPoint[]
  // Срез по услугам — проекция (имя продукта + метрики подвыборки), не ядровой тип.
  services?: { name: string; n: number; nps: number | null; csat: number | null }[]
}

// NPS ∈ [-100, 100] → ширина шкалы [0%, 100%] (−100→0, 0→50, 100→100). Клампим
// на случай аномального значения в ответе (клиент JSON не валидирует) — полоса не вылезет.
const barWidth = (nps: number): string => `${Math.max(0, Math.min(100, (nps + 100) / 2))}%`

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

const { data, error } = await useAsyncData<Dashboard>(`dashboard:${surveyKey.value}`, () =>
  $fetch(`/api/dashboard/${surveyKey.value}`)
)
</script>

<template>
  <main class="mx-auto max-w-4xl p-6">
    <header class="mb-6">
      <p class="text-sm text-gray-500 dark:text-gray-400">Результаты опроса</p>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">{{ data?.title ?? surveyKey }}</h1>
      <p v-if="data?.n !== undefined" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Ответов: {{ data.n }}
      </p>
    </header>

    <B24Alert
      v-if="error"
      color="air-primary-alert"
      title="Не удалось загрузить дашборд."
    />

    <B24Alert
      v-else-if="data?.suppressed"
      color="air-primary-warning"
      title="Недостаточно ответов"
      :description="`Данные скрыты для анонимности (порог — ${data.threshold}). Соберите больше ответов.`"
    />

    <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <B24Card v-if="data?.nps" title="NPS">
        <div class="flex items-baseline gap-2">
          <span class="text-4xl font-bold">{{ data.nps.nps }}</span>
        </div>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Промоутеры {{ data.nps.promoters }} · нейтралы {{ data.nps.passives }} · критики {{ data.nps.detractors }}
        </p>
      </B24Card>

      <B24Card v-if="data?.csat" title="CSAT">
        <div class="flex items-baseline gap-2">
          <span class="text-4xl font-bold">{{ data.csat.mean }}</span>
          <span class="text-sm text-gray-500 dark:text-gray-400">из 5</span>
        </div>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">Топ-бокс: {{ data.csat.topBoxPct }}%</p>
      </B24Card>

      <B24Card
        v-if="data?.distribution?.items?.length"
        :title="data.distribution.question"
        class="sm:col-span-2"
      >
        <ul class="flex flex-col gap-2">
          <li
            v-for="item in data.distribution.items"
            :key="item.label"
            class="flex items-center justify-between"
          >
            <span class="text-sm">{{ item.label }}</span>
            <B24Badge color="air-secondary-accent" :label="String(item.count)" />
          </li>
        </ul>
      </B24Card>

      <B24Card
        v-if="data?.trend?.length"
        title="Динамика NPS по месяцам"
        class="sm:col-span-2"
      >
        <ul class="flex flex-col gap-3">
          <li v-for="p in data.trend" :key="p.bucket" class="flex items-center gap-3">
            <span class="w-16 shrink-0 text-sm text-gray-500 dark:text-gray-400">{{ p.bucket }}</span>
            <div class="h-2 flex-1 rounded-full bg-gray-200 dark:bg-gray-700">
              <div class="h-2 rounded-full bg-sky-500" :style="{ width: barWidth(p.nps) }" />
            </div>
            <span class="w-10 shrink-0 text-right text-sm font-semibold">{{ p.nps }}</span>
            <span class="w-12 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">n={{ p.n }}</span>
          </li>
        </ul>
      </B24Card>

      <B24Card
        v-if="data?.services?.length"
        title="По услугам"
        class="sm:col-span-2"
      >
        <ul class="flex flex-col gap-2">
          <li v-for="(s, i) in data.services" :key="i" class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium">{{ s.name }}</span>
            <div class="flex items-center gap-3 text-sm">
              <span v-if="s.nps !== null">NPS <b>{{ s.nps }}</b></span>
              <span v-if="s.csat !== null">CSAT <b>{{ s.csat }}</b></span>
              <span class="text-xs text-gray-500 dark:text-gray-400">n={{ s.n }}</span>
            </div>
          </li>
        </ul>
      </B24Card>
    </div>
  </main>
</template>
