<script setup lang="ts">
// Дашборд результатов (контур B): аналитика опроса в нативной теме b24ui (air-токены, без
// индиго-айдентики контура A). Данные — серверный агрегат /api/dashboard/:key (domain/aggregate
// + подавление малых N; распределение приходит с метками опций). Тонкий рендер. Гейт requirePortalSession
// (fail-closed в проде; открыт вне production или с DASHBOARD_DEV_OPEN=1 — для демо). Tenant-фильтр — #49.
// Типы метрик — из ядра (type-only: в клиентский бандл не попадают, граница ~core
// соблюдена). Один источник правды с серверным агрегатом — расхождение ловит компилятор.
import { serverMessage } from '~core/client/server-message'
import type { NpsSummary, CsatSummary } from '~core/domain/metrics'
import type { TrendPoint, BreakdownRow } from '~core/domain/aggregate'

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
  // Срезы — проекции (имя группы + метрики подвыборки), не ядровые типы; рендерятся BreakdownCard.
  services?: BreakdownRow[]
  directions?: BreakdownRow[]
  responsibles?: BreakdownRow[]
  clients?: BreakdownRow[]
  versions?: number[]
  version?: number | null
}

// NPS ∈ [-100, 100] → ширина шкалы [0%, 100%] (−100→0, 0→50, 100→100). Клампим
// на случай аномального значения в ответе (клиент JSON не валидирует) — полоса не вылезет.
const barWidth = (nps: number): string => `${Math.max(0, Math.min(100, (nps + 100) / 2))}%`

// В индекс этой странице не надо: у контура A ссылка одноразовая, у дашборда без сессии
// портала виден только экран отказа. `robots.txt` это уже просит — здесь дублируем на
// уровне страницы, потому что robots.txt краулер вправе проигнорировать.
useSeoMeta({ robots: 'noindex, nofollow' })

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

// Фильтр по версии живёт в URL (`?version=N`) — деплинкуемый и SSR-дружелюбный (гейт снимает
// срез без клика). Невалидное значение → null (все версии). useAsyncData рефетчит при смене.
const selectedVersion = computed(() => {
  const v = Number(route.query.version)
  return Number.isInteger(v) && v > 0 ? v : null
})

const { data, error } = await useAsyncData<Dashboard>(
  () => `dashboard:${surveyKey.value}:${selectedVersion.value ?? 'all'}`,
  () =>
    $fetch(`/api/dashboard/${surveyKey.value}`, {
      query: selectedVersion.value != null ? { version: selectedVersion.value } : {}
    }),
  { watch: [selectedVersion] }
)

// Смена версии = навигация (состояние в URL): деплинк + кнопка «назад» работают сами собой.
// `query: {}` очищает `?version` (path берётся из текущего маршрута — остаёмся на `/d/:key`).
const selectVersion = (v: number | null) => navigateTo({ query: v != null ? { version: v } : {} })

/**
 * Что показать вместо дашборда, когда он не загрузился.
 *
 * Порядок такой же, как в контуре A: сначала текст сервера (он знает причину — «опрос не найден,
 * проверьте адрес»), потом наши строки на случаи, где сервер отвечает без тела. 401/503 приходят
 * из гейта авторизации (`requirePortalSession` бросает `createError`, а его конверт до сюда с нашим
 * текстом не доезжает) — поэтому их называем здесь и по-разному: первое чинит сам сотрудник,
 * второе — только администратор.
 *
 * ⚠️ 503 намеренно НЕ называет переменную окружения. Гейт срабатывает раньше проверки ключа, поэтому
 * `/d/что-угодно` открыт любому из интернета — и точный доклад «задайте `DASHBOARD_AUTH_SECRET`»
 * рассказал бы неизвестному, что авторизация дашборда сейчас не работает и какую ручку сторожить.
 * Имя переменной админ и так получит там, где ему удобнее: в логе запуска и в `pnpm env:check`.
 * Формулировка «не настроен» ещё и точнее: 503 отдаётся и когда секрет задан, но слишком короткий.
 */
const errorText = computed(() => {
  if (!error.value) return ''
  const fromServer = serverMessage(error.value)
  if (fromServer) return fromServer
  const status = error.value.statusCode
  if (status === 401) {
    return 'Сессия портала истекла. Закройте и заново откройте приложение из Bitrix24 — дашборд откроется снова.'
  }
  if (status === 503) {
    return 'Дашборд временно недоступен. Обратитесь к администратору приложения.'
  }
  return 'Не удалось загрузить дашборд. Проверьте подключение и обновите страницу.'
})
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

    <div v-if="(data?.versions?.length ?? 0) > 1" class="mb-6 flex flex-wrap items-center gap-2">
      <span class="text-sm text-gray-500 dark:text-gray-400">Версия:</span>
      <B24Button
        size="sm"
        :color="selectedVersion === null ? 'air-primary' : 'air-tertiary'"
        label="Все"
        @click="selectVersion(null)"
      />
      <B24Button
        v-for="v in data?.versions ?? []"
        :key="v"
        size="sm"
        :color="selectedVersion === v ? 'air-primary' : 'air-tertiary'"
        :label="`Версия ${v}`"
        @click="selectVersion(v)"
      />
    </div>

    <B24Alert
      v-if="error"
      color="air-primary-alert"
      :title="errorText"
    />

    <!-- Текст намеренно НЕ переписан вместе с остальными: состояние `suppressed` на демо-сиде не
         воспроизводится (там 12 ответов, порог 5) и потому не попадает ни в один эталон. Править
         вслепую то, что нельзя увидеть глазами, правила проекта запрещают — рерайт поедет вместе с
         постановкой состояния под гейт. -->
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

      <BreakdownCard v-if="data?.services?.length" title="По услугам" :rows="data.services" />
      <BreakdownCard v-if="data?.directions?.length" title="По направлениям" :rows="data.directions" />
      <BreakdownCard v-if="data?.responsibles?.length" title="По ответственным" :rows="data.responsibles" />
      <BreakdownCard v-if="data?.clients?.length" title="По клиентам" :rows="data.clients" />
    </div>

    <!-- Отзыв о сервисе: внутренний экран, сотрудник под сессией портала. На публичной странице
         прохождения опроса виджета быть не должно — там клиент заказчика. -->
    <FeedbackWidget screen="dashboard" :survey-key="surveyKey" />
  </main>
</template>
