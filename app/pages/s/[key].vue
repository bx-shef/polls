<script setup lang="ts">
// Маршрут прохождения опроса контура A: /s/:key. Оркеструет фазы (intro→survey→thanks)
// поверх композабла useSurvey (обёртка ядрового SurveyFill). Текущая версия грузится на SSR.
const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

const { phase, version, view, errorMsg, submitting, load, start, selectOption, setOther, setText, back, next } =
  useSurvey(surveyKey.value)

await load()
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
