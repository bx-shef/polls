<script setup lang="ts">
// Публичная справка целиком — из ТОГО ЖЕ реестра, что слайдер в интерфейсе и /llms.txt.
// Второй копии текста нет: страница не может разойтись с подсказками.
import { HELP_TOPICS, HELP_PRODUCT } from '~core/client/help'

useHead({ title: `Справка — ${HELP_PRODUCT}` })
useSeoMeta({
  description: 'Как работает сервис опросов для Bitrix24: запуск по стадии сделки, ответ клиента, результат в карточке, аналитика.'
})
</script>

<template>
  <main class="mx-auto max-w-3xl px-4 py-10">
    <NuxtLink to="/" class="text-sm text-gray-500 underline dark:text-gray-400">← На главную</NuxtLink>
    <h1 class="mt-4 text-3xl font-bold text-gray-900 dark:text-white">Справка</h1>

    <!-- Оглавление: те же якоря, на которые ссылается /llms.txt. -->
    <nav class="mt-6 flex flex-col gap-1" aria-label="Разделы справки">
      <a v-for="t in HELP_TOPICS" :key="t.key" :href="`#${t.key}`" class="text-sm underline">
        {{ t.title }}
      </a>
    </nav>

    <section v-for="t in HELP_TOPICS" :id="t.key" :key="t.key" class="mt-10">
      <h2 class="text-2xl font-semibold text-gray-900 dark:text-white">{{ t.title }}</h2>
      <div v-for="(s, i) in t.sections" :key="i" class="mt-4">
        <h3 v-if="s.heading" class="text-lg font-medium text-gray-900 dark:text-white">{{ s.heading }}</h3>
        <p v-for="(p, j) in s.paragraphs ?? []" :key="j" class="mt-2 leading-relaxed text-gray-700 dark:text-gray-300">
          {{ p }}
        </p>
        <ul v-if="s.bullets?.length" class="mt-2 flex list-disc flex-col gap-1 pl-6">
          <li v-for="(b, k) in s.bullets" :key="k" class="leading-relaxed text-gray-700 dark:text-gray-300">
            {{ b }}
          </li>
        </ul>
      </div>
    </section>
  </main>
</template>
