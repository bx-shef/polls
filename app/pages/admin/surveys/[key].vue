<script setup lang="ts">
// Редактор опроса (фаза мульти-сущность, MVP): загружает текущую версию как черновик
// (GET /api/admin/surveys/:key → versionToDraft) и публикует новую версию (POST …/publish).
// MVP: правка заголовка + текстов вопросов + стадий-триггеров (drag-and-drop конструктор —
// фаза полировки). Нативная b24ui-тема. Auth-гейт — на сервере (#47).
interface Draft {
  surveyKey: string
  title: string
  lang: string
  questions: { key: string; type: string; metric: string; text: string; options?: unknown[] }[]
  invitationPolicy?: { entityType?: string; spaEntityTypeId?: number; triggerStages?: string[]; channelOrder?: string[] }
}

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

const { data, error } = await useAsyncData<{ ok: boolean; draft: Draft; currentVersionNo: number }>(
  () => `admin-survey:${surveyKey.value}`,
  () => $fetch(`/api/admin/surveys/${surveyKey.value}`)
)

// Локальная редактируемая копия черновика (реактивная). Стадии-триггеры — строкой через запятую
// для простого ввода в MVP.
const draft = ref<Draft | null>(null)
const stagesInput = ref('')
watchEffect(() => {
  if (data.value?.ok) {
    draft.value = JSON.parse(JSON.stringify(data.value.draft))
    stagesInput.value = (data.value.draft.invitationPolicy?.triggerStages ?? []).join(', ')
  }
})

const saving = ref(false)
const saveMsg = ref<{ ok: boolean; text: string } | null>(null)

async function publish() {
  if (!draft.value) return
  saving.value = true
  saveMsg.value = null
  // Применяем введённые стадии в политику (если она есть).
  const stages = stagesInput.value.split(',').map((s) => s.trim()).filter(Boolean)
  if (draft.value.invitationPolicy) draft.value.invitationPolicy.triggerStages = stages
  try {
    const r = await $fetch<{ ok: boolean; versionNo?: number }>(`/api/admin/surveys/${surveyKey.value}/publish`, {
      method: 'POST',
      body: draft.value
    })
    saveMsg.value = { ok: true, text: `Опубликована версия v${r.versionNo}.` }
  } catch (e) {
    saveMsg.value = { ok: false, text: `Не удалось опубликовать: ${(e as { statusMessage?: string }).statusMessage ?? 'ошибка'}` }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-3xl p-6">
    <header class="mb-6">
      <B24Button color="air-tertiary" size="sm" label="← К списку" @click="navigateTo('/admin/surveys')" />
      <h1 class="mt-3 text-2xl font-semibold text-gray-900 dark:text-white">Редактирование опроса</h1>
      <p v-if="data?.ok" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Текущая версия v{{ data.currentVersionNo }} · публикация создаёт новую версию.
      </p>
    </header>

    <B24Alert v-if="error" color="air-primary-alert" title="Опрос не найден" />

    <div v-else-if="draft" class="flex flex-col gap-5">
      <B24Card variant="outline">
        <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Заголовок</label>
        <B24Input v-model="draft.title" size="lg" class="w-full" />

        <label class="mb-1 mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Стадии-триггеры <span class="text-gray-400">(через запятую)</span>
        </label>
        <B24Input
          v-model="stagesInput"
          :disabled="!draft.invitationPolicy"
          placeholder="C1:WON, EXECUTING"
          class="w-full"
        />
        <p v-if="!draft.invitationPolicy" class="mt-1 text-xs text-gray-400">
          У опроса нет привязки-датчика — запуск только вручную.
        </p>
      </B24Card>

      <section>
        <h2 class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Вопросы ({{ draft.questions.length }})</h2>
        <ul class="flex flex-col gap-3">
          <li v-for="(q, i) in draft.questions" :key="q.key">
            <B24Card variant="outline">
              <div class="mb-2 flex items-center gap-2">
                <B24Badge color="air-secondary-accent" size="sm" :label="q.metric" />
                <span class="font-mono text-xs text-gray-500 dark:text-gray-400">{{ q.key }}</span>
              </div>
              <B24Input v-model="draft.questions[i]!.text" class="w-full" />
            </B24Card>
          </li>
        </ul>
      </section>

      <div class="flex items-center gap-3">
        <B24Button color="air-primary" size="lg" label="Опубликовать новую версию" :loading="saving" @click="publish" />
        <span
          v-if="saveMsg"
          :class="saveMsg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
          class="text-sm"
        >{{ saveMsg.text }}</span>
      </div>
    </div>
  </main>
</template>
