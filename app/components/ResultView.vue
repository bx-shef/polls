<script setup lang="ts">
// Страница просмотра результата (#18): один ответ клиента целиком — вопросы той версии, которую он
// видел, его ответы и срез сделки. Открывается кнопкой «Открыть результат» на деле-результате в
// таймлайне; данные приходят с сервера уже собранными (`buildResultView`), здесь только показ.
//
// ⚠️ Всё выводится через `{{ }}` — свободный текст клиента идёт из чужого документа, и `v-html`
// здесь означал бы хранимый XSS внутри CRM заказчика.
//
// ⚠️ Печать — `window.print()` плюс `@media print`. Отдельного PDF-рендера на сервере НЕ заводим:
// браузер печатает в PDF сам, а серверный рендер потребовал бы тащить headless-браузер в прод-образ
// ради того, что уже есть у каждого. Экран живёт во фрейме портала, поэтому печатается именно он.
import type { ResultView } from '~core/domain/result-view'

const props = defineProps<{ view: ResultView }>()

/**
 * Дата ответа в языке портала. Битую строку показываем как есть, а не прячем: «—» вместо даты
 * выглядит как отсутствие данных, хотя данные есть и проблема в формате.
 */
/**
 * Печать — обработчиком, а не `window.print()` в шаблоне: компилятор Vue разрешает в выражениях
 * шаблона только свойства компонента и короткий белый список глобальных (`Math`, `Date`), а `window`
 * в него не входит — кнопка молча ничего бы не делала.
 */
function onPrint(): void {
  window.print()
}

const submitted = computed(() => {
  const d = new Date(props.view.submittedAt)
  return Number.isNaN(d.getTime())
    ? props.view.submittedAt
    : d.toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' })
})
</script>

<template>
  <article class="result">
    <header class="mb-4">
      <h1 class="text-lg font-semibold">{{ view.surveyTitle }}</h1>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-300">
        Клиент ответил {{ submitted }}
        <span class="whitespace-nowrap">· редакция {{ view.versionNo }}</span>
      </p>
      <p v-if="view.context.companyName || view.context.dealId" class="text-sm text-gray-600 dark:text-gray-300">
        <template v-if="view.context.companyName">{{ view.context.companyName }}</template>
        <template v-if="view.context.companyName && view.context.dealId"> · </template>
        <template v-if="view.context.dealId">сделка №{{ view.context.dealId }}</template>
      </p>
    </header>

    <!-- Пустой результат — не ошибка: клиент мог открыть анкету и отправить её, ничего не выбрав. -->
    <p v-if="view.lines.length === 0" class="text-sm">
      Клиент отправил анкету, не ответив ни на один вопрос.
    </p>
    <dl v-else class="flex flex-col gap-3">
      <div v-for="(line, i) in view.lines" :key="i" class="result-line">
        <dt class="text-sm text-gray-600 dark:text-gray-300">{{ line.label }}</dt>
        <!-- `whitespace-pre-line`: свободный текст клиента бывает многострочным, и склеивать его
             в одну строку значит терять смысл. Перенос по словам, а не обрезка. -->
        <dd class="whitespace-pre-line break-words font-medium">{{ line.value }}</dd>
      </div>
    </dl>

    <!-- ⚠️ Число пропущенных названо вслух: короткий список иначе читается как «данные потерялись». -->
    <p v-if="view.skipped > 0" class="mt-4 text-sm text-gray-600 dark:text-gray-300">
      Вопросов без ответа: {{ view.skipped }}.
    </p>

    <div class="no-print mt-5">
      <B24Button color="air-secondary" label="Распечатать или сохранить в PDF" @click="onPrint" />
    </div>
  </article>
</template>

<style scoped>
/* Печать: убираем всё, что на бумаге бессмысленно, и снимаем фон — чернила стоят денег. */
@media print {
  .no-print {
    display: none;
  }
  .result {
    color: #000;
    background: #fff;
  }
  /* Строка «вопрос → ответ» не должна разрываться между страницами: разорванная пара нечитаема. */
  .result-line {
    break-inside: avoid;
  }
}
</style>
