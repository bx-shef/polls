<script setup lang="ts">
import type { CompiledVersion } from '~core/domain/schema'

// Экран Интро (контур A): контент из презентации версии-снимка (`intro`, version-frozen #25),
// с осмысленными фолбэками, если поля не заданы. Кнопка «Начать» → фаза опроса.
const props = defineProps<{ version: CompiledVersion }>()
defineEmits<{ start: [] }>()

const intro = computed(() => props.version.intro ?? {})
const title = computed(() => intro.value.title ?? props.version.title)
</script>

<template>
  <B24Card variant="outline" class="w-full max-w-xl">
    <div class="flex flex-col items-center gap-5 py-2 text-center">
      <B24Badge v-if="intro.kicker" color="air-secondary-accent" :label="intro.kicker" />
      <h1 class="whitespace-pre-line text-3xl font-bold">{{ title }}</h1>
      <p v-if="intro.lead" class="max-w-md text-base text-gray-500">
        {{ intro.lead }}
      </p>
      <div v-if="intro.meta?.length" class="flex flex-wrap justify-center gap-2">
        <B24Badge v-for="m in intro.meta" :key="m" color="air-tertiary" :label="m" />
      </div>
      <B24Button color="air-primary" size="lg" :label="intro.cta ?? 'Начать'" @click="$emit('start')" />
      <p v-if="intro.count" class="text-sm text-gray-500">{{ intro.count }}</p>
    </div>
  </B24Card>
</template>
