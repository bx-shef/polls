<script setup lang="ts">
// Дашборд результатов (контур B): аналитика опроса в нативной теме b24ui (air-токены, без
// индиго-айдентики контура A). Данные — серверный агрегат /api/dashboard/:key (domain/aggregate
// + подавление малых N; распределение приходит с метками опций). Тонкий рендер. Гейт resolvePortalSession (роут отвечает текстом, а не броском)
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
  // `hiddenBins` — сколько ячеек подавлено k-анонимностью (#49). Метки и счётчики скрытых ячеек
  // сервер не отдаёт: их отдача сделала бы подавление декоративным.
  distribution?: {
    question: string
    items: { label: string; count: number }[]
    hiddenBins: number
    threshold: number
  } | null
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

// ⚠️ `useRequestFetch()`, а НЕ голый `$fetch`: на сервере запрос к своему же роуту идёт без заголовков
// исходного запроса, то есть без cookie `polls_portal`. В проде это означало, что дашборд, открытый
// по прямой ссылке или обновлённый по F5, отвечал «сессия истекла» при живой сессии — работал только
// переход из фрейма (клиентская навигация, там cookie уходит). Визуальный гейт этого не видит: он
// поднимает сервер с `DASHBOARD_DEV_OPEN=1`, где гейт вообще не срабатывает.
const requestFetch = useRequestFetch()
const { data, error } = await useAsyncData<Dashboard>(
  () => `dashboard:${surveyKey.value}:${selectedVersion.value ?? 'all'}`,
  // ⚠️ Тип указан и здесь, и у `useAsyncData` — обход предела рекурсии TypeScript, а не
  // избыточность: без него Nuxt выводит тип ответа из АДРЕСА (типизированные маршруты), и сравнение
  // выведенного типа с объявленным падает `TS2321: Excessive stack depth`, как только роутов
  // становится больше. Разбор — в `admin/surveys/[key].vue`.
  () =>
    requestFetch<Dashboard>(`/api/dashboard/${surveyKey.value}`, {
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
 * Текст — серверный, включая отказы гейта: роут отвечает телом (`resolvePortalSession`), а не броском,
 * поэтому своих строк на 401/503 здесь больше нет. Клиентская строка осталась ровно на случай, когда
 * ответа не пришло вовсе — обрыв связи или страница прокси.
 */
const errorText = computed(() =>
  !error.value
    ? ''
    : (serverMessage(error.value) ?? 'Не удалось загрузить дашборд. Проверьте подключение и обновите страницу.')
)

/**
 * Заголовок страницы: название опроса с сервера, иначе — статичная строка.
 *
 * Раньше фолбэком был сырой ключ из адреса, то есть ссылкой `/d/<двести символов текста>` рисовался
 * чужой текст заголовком на нашей странице. Экранирование от этого не спасает: оно закрывает разметку,
 * а не смысл. Фолбэк намеренно НЕ завязан на признак ошибки — иначе защита держалась бы на том, что
 * роут в другом файле не забыл выставить статус ответа.
 */
const heading = computed(() => data.value?.title ?? 'Дашборд опроса')
</script>

<template>
  <main class="mx-auto max-w-4xl p-6">
    <header class="mb-6">
      <p v-if="!error" class="text-sm text-gray-500 dark:text-gray-400">Результаты опроса</p>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">{{ heading }}</h1>
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

    <!-- Состояние теперь ВОСПРОИЗВОДИМО на демо-данных (второй опрос сида опубликован без ответов),
         поэтому оно под визуальным гейтом и текст переписан не вслепую. -->
    <B24Alert
      v-else-if="data?.suppressed"
      color="air-primary-warning"
      title="Пока мало ответов"
      :description="`Цифры откроются, когда ответов станет ${data.threshold} или больше: на меньшей выборке по ним можно было бы узнать конкретного человека. Ответы при этом собираются как обычно.`"
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

      <!-- Карточка живёт и при ПУСТОМ списке: два варианта, у одного единица — показывать нечего,
           но сказать, что распределение скрыто, обязаны. Молчаливое исчезновение блока читается как
           «вопрос не задавали». -->
      <B24Card
        v-if="data?.distribution"
        :title="data.distribution.question"
        class="sm:col-span-2"
      >
        <ul v-if="data.distribution.items.length" class="flex flex-col gap-2">
          <li
            v-for="item in data.distribution.items"
            :key="item.label"
            class="flex items-center justify-between"
          >
            <span class="text-sm">{{ item.label }}</span>
            <B24Badge color="air-secondary-accent" :label="String(item.count)" />
          </li>
        </ul>
        <p v-if="data.distribution.hiddenBins" class="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Скрыто вариантов: {{ data.distribution.hiddenBins }} — в каждом меньше
          {{ data.distribution.threshold }} ответов. Единичный вариант указывает на конкретного
          человека, поэтому такие строки не показываются.
        </p>
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
