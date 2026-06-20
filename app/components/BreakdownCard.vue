<script setup lang="ts">
// Карточка среза дашборда (контур B): строка на группу (имя + NPS/CSAT/n). Используется для
// услуг/направлений/ответственных/клиентов — единая разметка, данные из серверного агрегата
// (метрики уже подавлены по анонимности). Внутри `B24Card` текст наследует тему b24ui.
defineProps<{
  title: string
  rows: { name: string; n: number; nps: number | null; csat: number | null }[]
}>()
</script>

<template>
  <B24Card :title="title" class="sm:col-span-2">
    <ul class="flex flex-col gap-2">
      <li v-for="(row, i) in rows" :key="i" class="flex items-center justify-between gap-3">
        <span class="text-sm font-medium">{{ row.name }}</span>
        <div class="flex items-center gap-3 text-sm">
          <span v-if="row.nps !== null">NPS <b>{{ row.nps }}</b></span>
          <span v-if="row.csat !== null">CSAT <b>{{ row.csat }}</b></span>
          <span class="text-xs text-gray-500 dark:text-gray-400">n={{ row.n }}</span>
        </div>
      </li>
    </ul>
  </B24Card>
</template>
