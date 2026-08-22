<script setup lang="ts">
// Кнопка «?» — открывает тему справки слайдером, не уводя с экрана.
// ⚠️ Носитель подсказки — КНОПКА с aria-label: иконка сама по себе в порядок фокуса не попадает,
// и справка существовала бы только для мыши.
defineProps<{ topic: string }>()
const open = ref(false)
</script>

<template>
  <B24Button
    color="air-tertiary-no-accent"
    size="sm"
    aria-label="Открыть справку по этому экрану"
    label="?"
    @click="open = true"
  />
  <HelpSlider v-model:open="open" :topic="topic" />
</template>
