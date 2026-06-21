<script setup lang="ts">
// Конструктор опроса (фаза 5): полноценная правка структуры — добавить/удалить/переставить
// вопросы и опции, сменить тип/метрику/обязательность, задать баллы опций. Загружает текущую
// версию как черновик (GET …/:key) и публикует новую (POST …/publish) с оптимистичной блокировкой
// (expectedVersionNo → 409). Стабильные question_key/option_key — якоря сопоставимости версий:
// у существующих сохраняются, новым генерируем уникальный ключ. Валидация структуры — на сервере
// (surveyDraftSchema + compile); клиент даёт лёгкие подсказки. Нативная b24ui-тема. Auth — сервер (#47).
interface Option { key: string; label: string; score?: number | null }
interface Question { key: string; type: string; metric: string; required: boolean; text: string; options: Option[] }
interface Draft {
  surveyKey: string
  title: string
  lang: string
  questions: Question[]
  invitationPolicy?: { entityType?: string; spaEntityTypeId?: number; triggerStages?: string[]; channelOrder?: string[] }
}

const TYPE_ITEMS = [
  { label: 'Один выбор', value: 'single' },
  { label: 'Несколько выборов', value: 'multi' },
  { label: 'Текст', value: 'text' }
]
const METRIC_ITEMS = [
  { label: 'NPS', value: 'nps' },
  { label: 'CSAT', value: 'csat' },
  { label: 'CES', value: 'ces' },
  { label: 'Шкала', value: 'scale' },
  { label: 'Выбор', value: 'choice' },
  { label: 'Текст', value: 'text' }
]

// Уникальный ключ для нового вопроса/опции (стабильный якорь). База36 от времени + счётчик —
// детерминированно-уникален в пределах сессии редактирования; коллизии с существующими исключены
// префиксом и проверкой uniqueKey ниже.
let keySeq = 0
const genKey = (prefix: string, taken: Set<string>): string => {
  let k: string
  do {
    k = `${prefix}_${Date.now().toString(36)}${(keySeq++).toString(36)}`
  } while (taken.has(k))
  taken.add(k)
  return k
}

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

const { data, error, pending, refresh } = await useAsyncData<{ ok: boolean; draft: Draft; currentVersionNo: number }>(
  () => `admin-survey:${surveyKey.value}`,
  () => $fetch(`/api/admin/surveys/${surveyKey.value}`),
  { watch: [surveyKey] }
)

const draft = ref<Draft | null>(null)
const baseVersionNo = ref(0)
const stagesInput = ref('')

useHead({ title: () => (draft.value?.title ? `${draft.value.title} — конструктор опроса` : 'Конструктор опроса') })

watchEffect(() => {
  if (data.value?.ok) {
    draft.value = JSON.parse(JSON.stringify(data.value.draft))
    baseVersionNo.value = data.value.currentVersionNo
    stagesInput.value = (data.value.draft.invitationPolicy?.triggerStages ?? []).join(', ')
  }
})

// Множество занятых ключей — для генерации новых без коллизий.
const usedKeys = (): Set<string> => {
  const s = new Set<string>()
  for (const q of draft.value?.questions ?? []) {
    s.add(q.key)
    for (const o of q.options) s.add(o.key)
  }
  return s
}

function addQuestion() {
  if (!draft.value) return
  draft.value.questions.push({
    key: genKey('q', usedKeys()),
    type: 'single',
    metric: 'choice',
    required: true,
    text: '',
    options: []
  })
}
function removeQuestion(i: number) {
  draft.value?.questions.splice(i, 1)
}
function moveQuestion(i: number, dir: -1 | 1) {
  const qs = draft.value?.questions
  if (!qs) return
  const j = i + dir
  if (j < 0 || j >= qs.length) return
  ;[qs[i], qs[j]] = [qs[j]!, qs[i]!]
}
function addOption(q: Question) {
  q.options.push({ key: genKey('o', usedKeys()), label: '', score: null })
}
function removeOption(q: Question, j: number) {
  q.options.splice(j, 1)
}
function moveOption(q: Question, j: number, dir: -1 | 1) {
  const k = j + dir
  if (k < 0 || k >= q.options.length) return
  ;[q.options[j], q.options[k]] = [q.options[k]!, q.options[j]!]
}

const saving = ref(false)
const saveMsg = ref<{ ok: boolean; text: string } | null>(null)

async function publish() {
  if (!draft.value) return
  saving.value = true
  saveMsg.value = null
  const stages = stagesInput.value.split(',').map((s) => s.trim()).filter(Boolean)
  const payload = {
    ...draft.value,
    invitationPolicy: draft.value.invitationPolicy
      ? { ...draft.value.invitationPolicy, triggerStages: stages }
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
    const err = e as { statusMessage?: string; data?: { error?: string } }
    saveMsg.value = { ok: false, text: err.data?.error ?? err.statusMessage ?? 'Не удалось опубликовать' }
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

    <B24Alert v-if="error" color="air-primary-alert" title="Не удалось загрузить опрос" />
    <B24Alert v-else-if="!data?.ok && !pending" color="air-primary-alert" title="Опрос не найден" />
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
                <span class="font-mono text-xs text-gray-400">{{ q.key }}</span>
                <div class="flex items-center gap-1">
                  <B24Button color="air-tertiary" size="xs" label="↑" :disabled="i === 0" @click="moveQuestion(i, -1)" />
                  <B24Button color="air-tertiary" size="xs" label="↓" :disabled="i === draft.questions.length - 1" @click="moveQuestion(i, 1)" />
                  <B24Button color="air-primary-alert" size="xs" label="Удалить" @click="removeQuestion(i)" />
                </div>
              </div>

              <B24FormField label="Текст вопроса">
                <B24Input v-model="q.text" class="w-full" />
              </B24FormField>

              <div class="mt-3 flex flex-wrap items-end gap-3">
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
              <div v-if="q.type === 'single' || q.type === 'multi'" class="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
                <div class="mb-2 flex items-center justify-between">
                  <span class="text-xs font-medium text-gray-500 dark:text-gray-400">Опции ({{ q.options.length }})</span>
                  <B24Button color="air-tertiary" size="xs" label="+ Опция" @click="addOption(q)" />
                </div>
                <p v-if="!q.options.length" class="text-xs text-gray-400">Нет опций — добавьте варианты ответа.</p>
                <ul class="flex flex-col gap-2">
                  <li v-for="(o, j) in q.options" :key="o.key" class="flex items-center gap-2">
                    <B24Input v-model="o.label" placeholder="Текст варианта" class="flex-1" size="sm" />
                    <B24InputNumber v-model="o.score" placeholder="балл" class="w-24" size="sm" />
                    <B24Button color="air-tertiary" size="xs" label="↑" :disabled="j === 0" @click="moveOption(q, j, -1)" />
                    <B24Button color="air-tertiary" size="xs" label="↓" :disabled="j === q.options.length - 1" @click="moveOption(q, j, 1)" />
                    <B24Button color="air-primary-alert" size="xs" label="×" @click="removeOption(q, j)" />
                  </li>
                </ul>
              </div>
            </B24Card>
          </li>
        </ul>
      </section>

      <div class="flex flex-col gap-3">
        <B24Button
          color="air-primary"
          size="lg"
          label="Опубликовать новую версию"
          class="self-start"
          :loading="saving"
          @click="publish"
        />
        <B24Alert
          v-if="saveMsg"
          :color="saveMsg.ok ? 'air-primary-success' : 'air-primary-alert'"
          :title="saveMsg.text"
        />
      </div>
    </div>
  </main>
</template>
