<script setup lang="ts">
import type { PublicVersion } from '~core/domain/schema'

// Маршрут прохождения опроса контура A: /s/:key. Оркеструет фазы (intro→survey→thanks)
// поверх композабла useSurvey (обёртка ядрового SurveyFill).
//
// Версию грузим через useAsyncData: SSR-рендер + payload-трансфер (без двойного fetch при
// гидрации) + автоматический рефетч при client-навигации на другой :key (watch). Ошибку
// (404/сеть) useAsyncData ловит сам — в setup исключение не всплывает (нет 500 на SSR).
// Ремоунт при смене опроса (/s/A → /s/B): иначе Nuxt переиспользует инстанс страницы и
// onMounted (а с ним hydrate) не отрабатывает повторно. С ремоунтом — свежий setup + onMounted.
definePageMeta({ key: (route) => route.path })

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

// Ключ per-опрос: при ремоунте — свежий fetch, без кеша чужого опроса под общим ключом.
const { data, error } = await useAsyncData(
  `survey:${surveyKey.value}`,
  () => $fetch<{ ok: boolean; version: PublicVersion }>(`/api/survey/${surveyKey.value}/current`)
)

const { phase, version, view, errorMsg, submitting, reset, start, hydrate, selectOption, setOther, setText, back, next } =
  useSurvey()

// Прокидываем результат загрузки в композабл. watch immediate срабатывает СИНХРОННО в setup
// (до onMounted) → к моменту onMounted phase='intro', version заполнен.
watch([data, error], () => reset(data.value?.version ?? null, error.value ?? undefined), { immediate: true })

// Клиентская гидратация (после SSR, по факту монтирования): resume из localStorage +
// deep-link `?q=N` (1-based в URL → 0-based goTo). Зависит от порядка: watch выше уже отработал.
onMounted(() => {
  const q = route.query.q
  const idx = typeof q === 'string' && /^\d+$/.test(q) ? Math.max(0, parseInt(q, 10) - 1) : undefined
  hydrate(idx)
})
</script>

<template>
  <main class="flex min-h-screen items-center justify-center p-6">
    <p v-if="phase === 'loading'" class="text-gray-500 dark:text-gray-400">Загрузка…</p>

    <B24Alert
      v-else-if="phase === 'error'"
      color="air-primary-alert"
      :title="errorMsg"
      class="max-w-md"
    />

    <SurveyIntroScreen v-else-if="phase === 'intro' && version" :version="version" @start="start" />

    <SurveyQuestionScreen
      v-else-if="phase === 'survey' && view"
      :view="view"
      :submitting="submitting"
      :error-msg="errorMsg"
      @select="selectOption"
      @set-other="setOther"
      @set-text="setText"
      @next="next"
      @back="back"
    />

    <SurveyThanksScreen v-else-if="phase === 'thanks' && version" :version="version" />
  </main>
</template>
