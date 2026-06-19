<script setup lang="ts">
// Дашборд результатов (контур B): аналитика опроса в нативной теме b24ui (air-токены, без
// индиго-айдентики контура A). Данные — серверный агрегат /api/dashboard/:key (domain/aggregate
// + подавление малых N). Тонкий рендер: вся аналитика в ядре. DEV-ONLY (auth → #47).
interface NpsSummary { n: number; nps: number; promoters: number; passives: number; detractors: number }
interface CsatSummary { n: number; mean: number; topBoxPct: number }
interface Dashboard {
  ok: boolean
  title?: string
  n?: number
  suppressed?: boolean
  threshold?: number
  nps?: NpsSummary | null
  csat?: CsatSummary | null
  distribution?: { question: string; counts: Record<string, number> } | null
}

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

const { data, error } = await useAsyncData<Dashboard>(`dashboard:${surveyKey.value}`, () =>
  $fetch(`/api/dashboard/${surveyKey.value}`)
)

const dist = computed(() =>
  Object.entries(data.value?.distribution?.counts ?? {}).sort((a, b) => b[1] - a[1])
)
</script>

<template>
  <main class="mx-auto max-w-4xl p-6">
    <header class="mb-6">
      <p class="text-sm text-gray-500 dark:text-gray-400">Результаты опроса</p>
      <h1 class="text-2xl font-bold">{{ data?.title ?? surveyKey }}</h1>
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

      <B24Card v-if="dist.length" :title="data?.distribution?.question ?? 'Распределение'" class="sm:col-span-2">
        <ul class="flex flex-col gap-2">
          <li v-for="[key, count] in dist" :key="key" class="flex items-center justify-between">
            <span class="text-sm">{{ key }}</span>
            <B24Badge color="air-secondary-accent" :label="String(count)" />
          </li>
        </ul>
      </B24Card>
    </div>
  </main>
</template>
