<script setup lang="ts">
import type { SurveyView } from '~/composables/useSurvey'

// Экран Опроса: рендер текущего вопроса (single/multi/text + «Другое») штатными b24ui-формами.
// Логика выбора/exclusive/валидации — в ядре (SurveyFill); компонент только эмитит намерения.
const props = defineProps<{ view: SurveyView; submitting: boolean; errorMsg: string }>()
const emit = defineEmits<{
  select: [string]; setOther: [string]; setText: [string]; next: []; back: []
}>()

const q = computed(() => props.view.question)
const items = computed(() => q.value.options.map((o) => ({ value: o.key, label: o.label })))
const otherOption = computed(() => q.value.options.find((o) => o.isOther))
const otherPicked = computed(
  () => !!otherOption.value && props.view.answer.picked.includes(otherOption.value.key)
)

function onSingle(val: string | undefined) {
  if (val) emit('select', val)
}
// CheckboxGroup отдаёт новый массив; вычисляем изменившийся ключ и тогглим его через ядро.
// Это адаптер под API b24ui (массив, не дельта), НЕ бизнес-логика: exclusive/dedup целиком
// в SurveyFill.selectOption, состояние перечитывается обратно в model-value (одиночный клик).
function onMulti(vals: string[]) {
  const cur = props.view.answer.picked
  const changed = vals.find((v) => !cur.includes(v)) ?? cur.find((v) => !vals.includes(v))
  if (changed) emit('select', changed)
}
</script>

<template>
  <B24Card variant="outline" class="w-full max-w-xl">
    <div class="flex flex-col gap-5">
      <B24Progress :model-value="view.progress.current" :max="view.progress.total" />
      <p class="text-sm text-gray-500 dark:text-gray-400">Вопрос {{ view.progress.current }} из {{ view.progress.total }}</p>
      <h2 class="text-xl font-semibold">{{ q.text }}</h2>

      <B24RadioGroup
        v-if="q.type === 'single'"
        variant="card"
        :items="items"
        :model-value="view.answer.picked[0] ?? null"
        @update:model-value="onSingle"
      />
      <B24CheckboxGroup
        v-else-if="q.type === 'multi'"
        variant="card"
        :items="items"
        :model-value="view.answer.picked"
        @update:model-value="onMulti"
      />
      <B24Textarea
        v-else
        :model-value="view.answer.text"
        placeholder="Ваш ответ…"
        :rows="4"
        @update:model-value="emit('setText', $event)"
      />

      <B24Textarea
        v-if="otherPicked"
        :model-value="view.answer.other"
        placeholder="Уточните, пожалуйста…"
        @update:model-value="emit('setOther', $event)"
      />

      <B24Alert v-if="view.showError" color="air-primary-alert" title="Заполните вопрос, чтобы продолжить." />
      <B24Alert v-if="errorMsg" color="air-primary-alert" :title="errorMsg" />

      <div class="flex justify-between gap-3 pt-2">
        <B24Button
          color="air-tertiary"
          :disabled="view.isFirst || submitting"
          label="Назад"
          @click="emit('back')"
        />
        <B24Button
          color="air-primary"
          :loading="submitting"
          :label="view.isLast ? 'Отправить' : 'Далее'"
          @click="emit('next')"
        />
      </div>
    </div>
  </B24Card>
</template>
