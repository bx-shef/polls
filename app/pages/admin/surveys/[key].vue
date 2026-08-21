<script setup lang="ts">
// Конструктор опроса (фаза 5): полноценная правка структуры — добавить/удалить/переставить
// вопросы и опции, сменить тип/метрику/обязательность, задать баллы опций. Загружает текущую
// версию как черновик (GET …/:key) и публикует новую (POST …/publish) с оптимистичной блокировкой
// (expectedVersionNo → 409). Стабильные question_key/option_key — якоря сопоставимости версий:
// у существующих сохраняются, новым генерируем уникальный ключ. ЛОГИКА КОНСТРУКТОРА — в ядровом
// framework-agnostic модуле `~core/client/survey-editor` (под юнит-тестами); страница лишь держит
// реактивное состояние и зовёт чистые функции. Серверная авторитетная валидация — surveyDraftSchema +
// compile; клиент даёт грубые подсказки. Нативная b24ui-тема. Auth — сервер (#47).
import {
  TYPE_VALUES,
  METRIC_VALUES,
  addQuestion as coreAddQuestion,
  addOption as coreAddOption,
  moveItem,
  structureErrors as coreStructureErrors,
  normalizeForPublish,
  type EditorQuestion
} from '~core/client/survey-editor'
import { serverMessage } from '~core/client/server-message'
import type { InvitationPolicy } from '~core/domain/schema'

/**
 * Черновик в редакторе.
 *
 * ⚠️ Политика приглашения типизируется ЯДРОВЫМ типом, а не рукописной копией полей. Копия уже
 * отстала дважды (нет `linkTtlSeconds`, не было `resultToTimeline`), и держалась она только на том,
 * что публикация разворачивает пришедший объект спредом. Стоит кому-то «починить типы» и собрать
 * политику по полям — опрос с выключенным возвратом результата молча потеряет флаг на первом же
 * сохранении, а следующий ответ клиента уедет в карточку сделки.
 */
interface Draft {
  surveyKey: string
  title: string
  lang: string
  questions: EditorQuestion[]
  invitationPolicy?: Partial<InvitationPolicy>
}

// Подписи к каноническим значениям ядра (новый тип/метрика появится в UI сам, label — фолбэк на значение).
const TYPE_LABELS: Record<string, string> = { single: 'Один выбор', multi: 'Несколько выборов', text: 'Текст' }
const METRIC_LABELS: Record<string, string> = { nps: 'NPS', csat: 'CSAT', ces: 'CES', scale: 'Шкала', choice: 'Выбор', text: 'Текст' }
const TYPE_ITEMS = TYPE_VALUES.map((v) => ({ label: TYPE_LABELS[v] ?? v, value: v }))
const METRIC_ITEMS = METRIC_VALUES.map((v) => ({ label: METRIC_LABELS[v] ?? v, value: v }))

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

const { data, error, pending, refresh } = await useAsyncData<{
  ok: boolean
  draft: Draft
  currentVersionNo: number
  /** Администратор ли текущий пользователь портала: от этого зависит доступность публикации. */
  admin: boolean
}>(
  () => `admin-survey:${surveyKey.value}`,
  () => $fetch(`/api/admin/surveys/${surveyKey.value}`),
  { watch: [surveyKey] }
)

const draft = ref<Draft | null>(null)
const baseVersionNo = ref(0)
const stagesInput = ref('')
/**
 * «Класть результат в карточку сделки» (#18).
 *
 * ⚠️ Отдельный ref, а не правка `draft.invitationPolicy` на месте: у опроса политики может не быть
 * вовсе, и тогда редактировать нечего — а решение принять всё равно надо. Умолчание тут ТО ЖЕ, что в
 * ядре (`resultToTimelineEnabled`), и это единственное место, где оно повторяется: контрол обязан
 * показывать то, что произойдёт на самом деле, иначе он врёт молча.
 */
const resultToTimeline = ref(true)

useHead({ title: () => (draft.value?.title ? `${draft.value.title} — конструктор опроса` : 'Конструктор опроса') })

watchEffect(() => {
  if (data.value?.ok) {
    draft.value = JSON.parse(JSON.stringify(data.value.draft))
    baseVersionNo.value = data.value.currentVersionNo
    stagesInput.value = (data.value.draft.invitationPolicy?.triggerStages ?? []).join(', ')
    resultToTimeline.value = data.value.draft.invitationPolicy?.resultToTimeline ?? true
  }
})

// Тонкие реактивные обёртки над ядровыми чистыми функциями (мутируют draft.value.questions —
// Vue отслеживает). removeQuestion добавляет UI-подтверждение (деструктивно, без undo).
function addQuestion() {
  if (draft.value) coreAddQuestion(draft.value.questions)
}
function removeQuestion(i: number) {
  const q = draft.value?.questions[i]
  if (q && !window.confirm(`Удалить вопрос «${q.text || q.key}» со всеми опциями?`)) return
  draft.value?.questions.splice(i, 1)
}
function moveQuestion(i: number, dir: -1 | 1) {
  if (draft.value) moveItem(draft.value.questions, i, dir)
}
function addOption(i: number) {
  if (draft.value) coreAddOption(draft.value.questions, i)
}
function removeOption(q: EditorQuestion, j: number) {
  q.options.splice(j, 1)
}
function moveOption(q: EditorQuestion, j: number, dir: -1 | 1) {
  moveItem(q.options, j, dir)
}

const structureErrors = computed<string[]>(() => coreStructureErrors(draft.value?.questions ?? []))

const saving = ref(false)
const saveMsg = ref<{ ok: boolean; text: string } | null>(null)

/**
 * Можно ли публиковать. Правду решает сервер (он ответит 403), здесь — чтобы не показывать кнопку,
 * которая заведомо не сработает. Роль снимается в момент входа в приложение, поэтому после выдачи
 * прав нужно переоткрыть фрейм — об этом сказано в подсказке рядом с кнопкой.
 */
const canPublish = computed(() => data.value?.admin === true)

async function publish() {
  if (!draft.value || structureErrors.value.length || !canPublish.value) return
  saving.value = true
  saveMsg.value = null
  const stages = stagesInput.value.split(',').map((s) => s.trim()).filter(Boolean)
  // Нормализация вопросов к публикации — в ядре (text → options [], score null → undefined).
  const questions = normalizeForPublish(draft.value.questions)
  const payload = {
    ...draft.value,
    questions,
    // ⚠️ Спред сохраняет поля политики, которых редактор не знает (`channelOrder`, `linkTtlSeconds`):
    // публикация не должна терять то, что выставили не здесь.
    invitationPolicy: draft.value.invitationPolicy
      ? { ...draft.value.invitationPolicy, triggerStages: stages, resultToTimeline: resultToTimeline.value }
      : undefined,
    expectedVersionNo: baseVersionNo.value
  }
  try {
    const r = await $fetch<{ ok: boolean; versionNo?: number }>(`/api/admin/surveys/${surveyKey.value}/publish`, {
      method: 'POST',
      body: payload
    })
    saveMsg.value = { ok: true, text: `Опубликована версия v${r.versionNo}.` }
    await refresh()
  } catch (e) {
    // Обе формы ответа (тело роута и конверт брошенного `createError`) разбирает ядровая
    // `serverMessage`; фолбэк на английский `statusMessage` убран — админ его читать не должен.
    saveMsg.value = {
      ok: false,
      text: serverMessage(e) ?? 'Не удалось опубликовать. Попробуйте ещё раз.'
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-3xl p-6">
    <header class="mb-6">
      <B24Button color="air-tertiary" size="sm" label="К списку" @click="navigateTo('/admin/surveys')" />
      <h1 class="mt-3 text-2xl font-semibold text-gray-900 dark:text-white">Конструктор опроса</h1>
      <p v-if="data?.ok" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Текущая версия v{{ baseVersionNo }} · публикация создаёт новую версию.
      </p>
    </header>

    <B24Alert v-if="error" color="air-primary-alert" title="Не удалось загрузить опрос. Обновите страницу." />
    <B24Alert v-else-if="!data?.ok && !pending" color="air-primary-alert" title="Опрос не найден. Вернитесь к списку опросов." />
    <p v-else-if="pending" class="text-sm text-gray-500 dark:text-gray-400">Загрузка…</p>

    <div v-else-if="draft" class="flex flex-col gap-5">
      <B24Card variant="outline">
        <B24FormField label="Заголовок">
          <B24Input v-model="draft.title" size="lg" class="w-full" />
        </B24FormField>

        <B24FormField
          label="Стадии-триггеры"
          :hint="draft.invitationPolicy ? 'Через запятую' : 'У опроса нет привязки-датчика — запуск только вручную'"
          class="mt-4"
        >
          <B24Input
            v-model="stagesInput"
            :disabled="!draft.invitationPolicy"
            placeholder="C1:WON, EXECUTING"
            class="w-full"
          />
        </B24FormField>

        <!--
          ⚠️ Контрол обязателен, а не «удобство»: без него выключить возврат результата можно было бы
          только сырым публикующим запросом, то есть автор опроса, обещавшего на интро «Анонимно», не
          мог бы сдержать обещание вообще никак. Подпись говорит про РАСКРЫТИЕ, а не про галочку:
          менеджер увидит ответ конкретного клиента, и порог «меньше пяти не показываем» сюда не
          распространяется по построению.
        -->
        <B24FormField
          label="Результат — в карточку сделки"
          :hint="draft.invitationPolicy
            ? 'Менеджер увидит ответы этого клиента прямо в сделке. Выключите, если опрос обещает анонимность: правило «меньше пяти ответов не показываем» на карточку не действует. Настройка действует на ссылки, выписанные ПОСЛЕ публикации: по уже разосланным работает то, что было обещано тогда.'
            : 'У опроса нет привязки-датчика — записывать результат некуда'"
          class="mt-4"
        >
          <B24Switch v-model="resultToTimeline" :disabled="!draft.invitationPolicy" />
        </B24FormField>
      </B24Card>

      <section>
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-sm font-medium text-gray-700 dark:text-gray-300">Вопросы ({{ draft.questions.length }})</h2>
          <B24Button color="air-secondary" size="sm" label="+ Вопрос" @click="addQuestion" />
        </div>

        <p v-if="!draft.questions.length" class="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          Пока нет вопросов. Добавьте первый.
        </p>

        <ul class="flex flex-col gap-3">
          <li v-for="(q, i) in draft.questions" :key="q.key">
            <B24Card variant="outline">
              <div class="mb-3 flex items-center justify-between gap-2">
                <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Вопрос {{ i + 1 }}<span class="ml-2 font-mono text-xs font-normal text-gray-400">{{ q.key }}</span>
                </span>
                <div class="flex items-center gap-1">
                  <B24Button color="air-tertiary" size="xs" label="↑" aria-label="Переместить вопрос выше" :disabled="i === 0" @click="moveQuestion(i, -1)" />
                  <B24Button color="air-tertiary" size="xs" label="↓" aria-label="Переместить вопрос ниже" :disabled="i === draft.questions.length - 1" @click="moveQuestion(i, 1)" />
                  <B24Button color="air-primary-alert" size="xs" label="Удалить" :disabled="draft.questions.length === 1" @click="removeQuestion(i)" />
                </div>
              </div>

              <B24FormField label="Текст вопроса">
                <B24Input v-model="q.text" class="w-full" />
              </B24FormField>

              <div class="mt-3 flex flex-wrap items-center gap-3">
                <B24FormField label="Тип">
                  <B24Select v-model="q.type" :items="TYPE_ITEMS" class="w-44" />
                </B24FormField>
                <B24FormField label="Метрика">
                  <B24Select v-model="q.metric" :items="METRIC_ITEMS" class="w-40" />
                </B24FormField>
                <B24FormField label="Обязательный">
                  <B24Switch v-model="q.required" />
                </B24FormField>
              </div>

              <!-- Опции — только для вопросов с выбором -->
              <div v-if="q.type === 'single' || q.type === 'multi'" class="mt-4 border-t border-gray-200 pt-3 dark:border-gray-700">
                <div class="mb-2 flex items-center justify-between">
                  <span class="text-xs font-medium text-gray-500 dark:text-gray-400">Опции ({{ q.options.length }})</span>
                  <B24Button color="air-tertiary" size="xs" label="+ Опция" @click="addOption(i)" />
                </div>
                <p v-if="!q.options.length" class="text-xs text-gray-400">Нет опций — добавьте варианты ответа.</p>
                <ul class="flex flex-col gap-2">
                  <li v-for="(o, j) in q.options" :key="o.key" class="flex items-center gap-2">
                    <B24Input v-model="o.label" placeholder="Текст варианта" class="flex-1" size="sm" />
                    <B24InputNumber v-model="o.score" placeholder="балл" class="w-24" size="sm" />
                    <B24Button color="air-tertiary" size="xs" label="↑" aria-label="Переместить опцию выше" :disabled="j === 0" @click="moveOption(q, j, -1)" />
                    <B24Button color="air-tertiary" size="xs" label="↓" aria-label="Переместить опцию ниже" :disabled="j === q.options.length - 1" @click="moveOption(q, j, 1)" />
                    <B24Button color="air-primary-alert" size="xs" label="×" aria-label="Удалить опцию" @click="removeOption(q, j)" />
                  </li>
                </ul>
              </div>
            </B24Card>
          </li>
        </ul>
      </section>

      <div class="flex flex-col gap-3">
        <B24Alert
          v-if="structureErrors.length"
          color="air-primary-warning"
          title="Исправьте перед публикацией"
          :description="structureErrors.join(' ')"
        />
        <B24Alert
          v-if="!canPublish"
          color="air-primary-warning"
          title="Публиковать может только администратор портала"
          description="Правки можно готовить и сейчас — они остаются в конструкторе. Опубликовать новую версию попросите администратора Bitrix24. Если права вам только что выдали, закройте и заново откройте приложение."
        />
        <B24Button
          color="air-primary"
          size="lg"
          label="Опубликовать новую версию"
          class="self-start"
          :loading="saving"
          :disabled="!canPublish || structureErrors.length > 0"
          @click="publish"
        />
        <B24Alert
          v-if="saveMsg"
          :color="saveMsg.ok ? 'air-primary-success' : 'air-primary-alert'"
          :title="saveMsg.text"
        />
      </div>

      <!-- Отзыв о сервисе. Конструктор — шаг, на котором чаще всего застревают, поэтому виджет
           нужен здесь не меньше, чем на дашборде. -->
      <FeedbackWidget screen="admin" :survey-key="surveyKey" :version-no="baseVersionNo || undefined" />
    </div>
  </main>
</template>
