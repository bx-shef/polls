<script setup lang="ts">
import type { PublicVersion } from '~core/domain/schema'

// Экран Спасибо: контент из презентации версии-снимка (`thanks`, version-frozen #25) с фолбэками.
const props = defineProps<{ version: PublicVersion }>()
const thanks = computed(() => props.version.thanks ?? {})
</script>

<template>
  <B24Card variant="outline" class="w-full max-w-xl">
    <div class="flex flex-col items-center gap-4 py-4 text-center">
      <B24Badge color="air-primary-success" label="Готово" />
      <h1 class="text-2xl font-bold">{{ thanks.title ?? 'Спасибо за ответы!' }}</h1>
      <p v-if="thanks.body" class="text-base text-gray-500 dark:text-gray-400">{{ thanks.body }}</p>
      <p v-if="thanks.note" class="text-sm text-gray-500 dark:text-gray-400">{{ thanks.note }}</p>
    </div>
  </B24Card>
</template>
