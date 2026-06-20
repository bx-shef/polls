<script setup lang="ts">
// Каркас-заглушка корневого маршрута: подтверждает, что Nuxt + b24ui рендерят страницу
// ШТАТНЫМИ компонентами (B24Card / B24Badge / B24Button) на air-токенах темы — без
// ручной вёрстки и хардкод-цветов, поэтому светлая/тёмная тема работают из коробки.
// У `/` нет своего опроса (опросы адресуются по `:key`), поэтому кнопка ведёт на
// демо-опрос (сид) — чтобы корень не был тупиком при показе/тесте.
const DEMO_SURVEY = '/s/csat_postdeal'
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-8">
    <B24Card
      variant="outline"
      title="Каркас Nuxt + b24ui"
      class="w-full max-w-xl text-center"
    >
      <template #description>
        Приложение поднято. Дальше — экраны опроса поверх готового ядра
        (<code>SurveyFill</code>) и Nitro-привязка к <code>createApi</code>.
      </template>

      <div class="flex flex-col items-center gap-6">
        <B24Badge color="air-secondary-accent" size="md" label="Опрос · контур A" />
        <B24Button color="air-primary" size="lg" label="Начать" @click="navigateTo(DEMO_SURVEY)" />
      </div>
    </B24Card>
  </div>
</template>
