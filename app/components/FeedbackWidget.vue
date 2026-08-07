<script setup lang="ts">
/**
 * Виджет обратной связи 👍/👎 для ВНУТРЕННИХ экранов (дашборд, конструктор, виджеты портала).
 *
 * ⚠️ На публичной странице прохождения опроса (`/s/:key`) его быть не должно: там клиент заказчика,
 * сессии портала у него нет, а анонимный приём отзывов — готовый спам-канал в чужой трекер.
 *
 * Поведение по замыслу: 👍 уходит сразу (не заставляем писать, когда всё хорошо), 👎 сначала просит
 * пару слов — именно там объяснение и нужно. Если канал не настроен, виджет не показывается вовсе.
 */
const props = defineProps<{
  /** Экран, с которого отправлен отзыв: попадает в issue как контекст. */
  screen: string
  /** Ключ опроса, если экран о конкретном опросе. */
  surveyKey?: string
  /** Номер версии опроса. */
  versionNo?: number
}>()

const { enabled, phase, error, send } = useFeedback()
const comment = ref('')

const context = computed(() => ({
  screen: props.screen,
  ...(props.surveyKey ? { surveyKey: props.surveyKey } : {}),
  ...(props.versionNo ? { versionNo: props.versionNo } : {})
}))

async function thumbUp() {
  await send('up', '', context.value)
}

function askComment() {
  phase.value = 'commenting'
}

async function submitDown() {
  await send('down', comment.value, context.value)
}
</script>

<template>
  <section v-if="enabled" class="mt-8 border-t border-base-200 pt-4 dark:border-base-800">
    <div v-if="phase === 'idle'" class="flex flex-wrap items-center gap-3">
      <span class="text-sm text-base-600 dark:text-base-300">Приложение помогает в работе?</span>
      <B24Button color="air-tertiary" size="sm" label="👍 Да" @click="thumbUp" />
      <B24Button color="air-tertiary" size="sm" label="👎 Нет" @click="askComment" />
    </div>

    <div v-else-if="phase === 'commenting'" class="flex flex-col gap-3">
      <label for="feedback-comment" class="text-sm text-base-600 dark:text-base-300">
        Что пошло не так? Напишите пару слов — это поможет починить.
      </label>
      <B24Textarea id="feedback-comment" v-model="comment" :rows="3" placeholder="Например: дашборд долго грузится" />
      <div class="flex items-center gap-3">
        <B24Button color="air-primary" size="sm" label="Отправить" :loading="phase === 'sending'" @click="submitDown" />
        <B24Button color="air-tertiary" size="sm" label="Отмена" @click="phase = 'idle'" />
      </div>
    </div>

    <B24Alert v-else-if="phase === 'sent'" color="air-primary-success" title="Спасибо, отзыв отправлен." />

    <B24Alert v-else-if="phase === 'failed'" color="air-primary-alert" :title="error" />

    <div v-else class="text-sm text-base-600 dark:text-base-300">Отправляем отзыв…</div>
  </section>
</template>
