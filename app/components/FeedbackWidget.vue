<script setup lang="ts">
import type { FeedbackScreen } from '~core/domain/feedback'

/**
 * Виджет обратной связи 👍/👎 для ВНУТРЕННИХ экранов. Сейчас стоит на дашборде и в конструкторе.
 *
 * ⚠️ На публичной странице прохождения опроса (`/s/:key`) его быть не должно: там клиент заказчика,
 * сессии портала у него нет, а анонимный приём отзывов — готовый спам-канал в чужой трекер.
 *
 * Поведение по замыслу: 👍 уходит сразу (не заставляем писать, когда всё хорошо), 👎 сначала просит
 * пару слов — именно там объяснение и нужно. Если канал не настроен, виджет не показывается вовсе.
 * Отказ — не тупик: даём вернуться и повторить, не потеряв набранный текст.
 */
const props = defineProps<{
  /** Экран, с которого отправлен отзыв. Сервер принимает только значения из `FEEDBACK_SCREENS`. */
  screen: FeedbackScreen
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
        <!-- `loading` здесь не нужен: при отправке эта ветка размонтируется в пользу «Отправляем отзыв…». -->
        <B24Button color="air-primary" size="sm" label="Отправить" @click="submitDown" />
        <B24Button color="air-tertiary" size="sm" label="Отмена" @click="phase = 'idle'" />
      </div>
    </div>

    <B24Alert v-else-if="phase === 'sent'" color="air-primary-success" title="Спасибо, отзыв отправлен." />

    <!-- Отказ не терминальный: текст ошибки просит попробовать снова, значит такая возможность
         должна быть на экране. Набранный комментарий при этом сохраняется. -->
    <div v-else-if="phase === 'failed'" class="flex flex-col gap-3">
      <B24Alert color="air-primary-alert" :title="error" />
      <B24Button
        color="air-tertiary"
        size="sm"
        label="Попробовать снова"
        class="self-start"
        @click="phase = comment ? 'commenting' : 'idle'"
      />
    </div>

    <div v-else class="text-sm text-base-600 dark:text-base-300">Отправляем отзыв…</div>
  </section>
</template>
