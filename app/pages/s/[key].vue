<script setup lang="ts">
import type { PublicVersion } from '~core/domain/schema'

// Маршрут прохождения опроса контура A: /s/:key. Оркеструет фазы (intro→survey→thanks)
// поверх композабла useSurvey (обёртка ядрового SurveyFill).
//
// Версию грузим через useAsyncData: SSR-рендер + payload-трансфер (без двойного fetch при
// гидрации) + автоматический рефетч при client-навигации на другой :key (watch). Ошибку
// (404/сеть) useAsyncData ловит сам — в setup исключение не всплывает (нет 500 на SSR).
const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

const { data, error } = await useAsyncData(
  'survey-current',
  () => $fetch<{ ok: boolean; version: PublicVersion }>(`/api/survey/${surveyKey.value}/current`),
  { watch: [surveyKey] }
)

const { phase, version, view, errorMsg, submitting, reset, start, selectOption, setOther, setText, back, next } =
  useSurvey()

// Прокидываем результат загрузки в композабл (и при первичном рендере, и при смене :key).
watch([data, error], () => reset(data.value?.version ?? null, error.value ?? undefined), { immediate: true })
</script>

<template>
  <main class="flex min-h-screen items-center justify-center p-6">
    <p v-if="phase === 'loading'" class="text-gray-500">Загрузка…</p>

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
