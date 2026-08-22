<script setup lang="ts">
// Пояснение «по месту»: тема справки в слайдере поверх рабочего экрана (идея — из соседнего
// проекта: человек читает подсказку, не теряя контекста, в котором возник вопрос).
// Источник текста — ЕДИНЫЙ реестр `~core/client/help`: тот же, что публикует `/docs` и `/llms.txt`.
// Рендер только через `{{ }}` — v-html в app/** запрещён гардом (пустой белый список).
import { helpTopic } from '~core/client/help'

const props = defineProps<{ topic: string }>()
const open = defineModel<boolean>('open', { default: false })

// Опечатка в ключе темы ловится тестом реестра; на рантайме недостижима, но фолбэк честный.
const t = computed(() => helpTopic(props.topic))
</script>

<template>
  <B24Slideover
    v-model:open="open"
    :title="t?.title ?? 'Справка'"
    :description="t?.summary ?? ''"
  >
    <template #body>
      <div v-if="t" class="flex flex-col gap-5">
        <section v-for="(s, i) in t.sections" :key="i" class="flex flex-col gap-2">
          <h3 v-if="s.heading" class="text-sm font-semibold">{{ s.heading }}</h3>
          <p v-for="(p, j) in s.paragraphs ?? []" :key="j" class="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
            {{ p }}
          </p>
          <ul v-if="s.bullets?.length" class="flex list-disc flex-col gap-1 pl-5">
            <li v-for="(b, k) in s.bullets" :key="k" class="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
              {{ b }}
            </li>
          </ul>
        </section>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          Вся справка целиком — на странице
          <NuxtLink to="/docs" target="_blank" class="underline">/docs</NuxtLink>.
        </p>
      </div>
      <p v-else class="text-sm text-gray-500 dark:text-gray-400">Раздел справки не найден.</p>
    </template>
  </B24Slideover>
</template>
