<script setup lang="ts">
// Админ-экран «Опросы» (фаза мульти-сущность): список опросов портала с фильтром по типу
// сущности — поверх GET /api/admin/surveys (auth-гейт). Референс-макет — список шаблонов
// печатных форм Bitrix24 (таблица + фильтр). Нативная b24ui-тема (как дашборд контура B).
// Тип SurveySummary определён ИНЛАЙН: граница ~core/store — server-only (SQL/секреты), в
// клиентский бандл его тащить нельзя; форма дублируется осознанно (расхождение поймает сервер).
interface SurveySummary {
  surveyKey: string
  title: string
  lang: string
  currentVersionNo: number
  entityType?: 'deal' | 'lead' | 'spa' | 'contact' | 'company' | 'task'
  spaEntityTypeId?: number
  triggerStages: string[]
}

// Человекочитаемые подписи типов сущностей (UI-словарь; ключи синхронны ENTITY_TYPES ядра).
const ENTITY_LABELS: Record<NonNullable<SurveySummary['entityType']>, string> = {
  deal: 'Сделка',
  lead: 'Лид',
  spa: 'Смарт-процесс',
  contact: 'Контакт',
  company: 'Компания',
  task: 'Задача'
}

const { data, error } = await useAsyncData<{ ok: boolean; surveys: SurveySummary[] }>(
  'admin-surveys',
  () => $fetch('/api/admin/surveys')
)

// Фильтр по типу сущности живёт в URL (?entity=lead) — деплинкуемый, SSR-дружелюбный, гейт
// снимает срез без клика. 'all' / неизвестное → без фильтра.
const route = useRoute()
const entityFilter = computed(() => String(route.query.entity ?? 'all'))
const setFilter = (e: string) => navigateTo({ query: e === 'all' ? {} : { entity: e } })

const surveys = computed(() => data.value?.surveys ?? [])
const filtered = computed(() =>
  entityFilter.value === 'all' ? surveys.value : surveys.value.filter((s) => s.entityType === entityFilter.value)
)

// Кнопки фильтра — только типы, реально встречающиеся в списке (+ «Все»).
const presentEntities = computed(() => [...new Set(surveys.value.map((s) => s.entityType).filter(Boolean))] as string[])
</script>

<template>
  <main class="mx-auto max-w-4xl p-6">
    <header class="mb-6">
      <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">Опросы</h1>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Опросы портала и их привязка к сущности и стадиям-триггерам.
      </p>
    </header>

    <B24Alert
      v-if="error"
      color="air-primary-alert"
      title="Не удалось загрузить список опросов"
      :description="'Проверьте доступ к порталу и повторите.'"
    />

    <template v-else>
      <!-- Фильтр по типу сущности -->
      <div v-if="presentEntities.length" class="mb-5 flex flex-wrap gap-2">
        <B24Button
          :color="entityFilter === 'all' ? 'air-primary' : 'air-tertiary'"
          size="sm"
          label="Все"
          @click="setFilter('all')"
        />
        <B24Button
          v-for="e in presentEntities"
          :key="e"
          :color="entityFilter === e ? 'air-primary' : 'air-tertiary'"
          size="sm"
          :label="ENTITY_LABELS[e as keyof typeof ENTITY_LABELS] ?? e"
          @click="setFilter(e)"
        />
      </div>

      <p v-if="!filtered.length" class="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-500 dark:border-gray-700 dark:text-gray-400">
        Опросов нет.
      </p>

      <ul v-else class="flex flex-col gap-3">
        <li v-for="s in filtered" :key="s.surveyKey">
          <B24Card variant="outline">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <h2 class="truncate text-lg font-medium text-gray-900 dark:text-white">{{ s.title }}</h2>
                  <B24Badge color="air-secondary-accent" size="sm" :label="`v${s.currentVersionNo}`" />
                </div>
                <p class="mt-0.5 truncate font-mono text-xs text-gray-500 dark:text-gray-400">{{ s.surveyKey }}</p>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <B24Badge
                    v-if="s.entityType"
                    color="air-secondary"
                    size="sm"
                    :label="ENTITY_LABELS[s.entityType] + (s.spaEntityTypeId ? ` #${s.spaEntityTypeId}` : '')"
                  />
                  <B24Badge
                    v-for="stage in s.triggerStages"
                    :key="stage"
                    color="air-tertiary"
                    size="sm"
                    :label="stage"
                  />
                  <span v-if="s.entityType && !s.triggerStages.length" class="text-xs text-gray-400">
                    запуск вручную (без стадии)
                  </span>
                </div>
              </div>
              <B24Button
                color="air-secondary"
                size="sm"
                label="Редактировать"
                @click="navigateTo(`/admin/surveys/${s.surveyKey}`)"
              />
            </div>
          </B24Card>
        </li>
      </ul>
    </template>
  </main>
</template>
