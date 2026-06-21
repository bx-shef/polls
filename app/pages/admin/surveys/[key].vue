<script setup lang="ts">
// Редактор опроса (фаза мульти-сущность, MVP): загружает текущую версию как черновик
// (GET /api/admin/surveys/:key → versionToDraft) и публикует новую версию (POST …/publish).
// MVP: правка заголовка + текстов вопросов + стадий-триггеров. Добавление/удаление вопросов и
// опций, смена метрики — фаза полировки (drag-and-drop конструктор). Нативная b24ui-тема.
// Auth-гейт — на сервере (#47). Оптимистичная блокировка: отправляем expectedVersionNo (загруженную
// версию) — сервер вернёт 409, если опрос опубликовали в промежутке (не затираем чужую правку).
interface Draft {
  surveyKey: string
  title: string
  lang: string
  questions: { key: string; type: string; metric: string; text: string; options?: unknown[] }[]
  invitationPolicy?: { entityType?: string; spaEntityTypeId?: number; triggerStages?: string[]; channelOrder?: string[] }
}

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

const { data, error, pending, refresh } = await useAsyncData<{ ok: boolean; draft: Draft; currentVersionNo: number }>(
  () => `admin-survey:${surveyKey.value}`,
  () => $fetch(`/api/admin/surveys/${surveyKey.value}`),
  { watch: [surveyKey] }
)

// Локальная редактируемая копия черновика + загруженный номер версии (для оптимистичной блокировки).
const draft = ref<Draft | null>(null)
const baseVersionNo = ref(0)
const stagesInput = ref('')

useHead({ title: () => (draft.value?.title ? `${draft.value.title} — редактор опроса` : 'Редактор опроса') })
watchEffect(() => {
  if (data.value?.ok) {
    draft.value = JSON.parse(JSON.stringify(data.value.draft))
    baseVersionNo.value = data.value.currentVersionNo
    stagesInput.value = (data.value.draft.invitationPolicy?.triggerStages ?? []).join(', ')
  }
})

const saving = ref(false)
const saveMsg = ref<{ ok: boolean; text: string } | null>(null)

async function publish() {
  if (!draft.value) return
  saving.value = true
  saveMsg.value = null
  // Формируем payload, НЕ мутируя локальный draft (на случай ошибки/повтора): применяем введённые
  // стадии + кладём expectedVersionNo для оптимистичной блокировки.
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
    await refresh() // перечитываем актуальную версию (currentVersionNo/baseVersionNo обновятся)
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
      <h1 class="mt-3 text-2xl font-semibold text-gray-900 dark:text-white">Редактирование опроса</h1>
      <p v-if="data?.ok" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Текущая версия v{{ baseVersionNo }} · публикация создаёт новую версию.
      </p>
    </header>

    <B24Alert v-if="error" color="air-primary-alert" title="Не удалось загрузить опрос" />
    <B24Alert v-else-if="!data?.ok && !pending" color="air-primary-alert" title="Опрос не найден" />
    <p v-else-if="pending" class="text-sm text-gray-500 dark:text-gray-400">Загрузка…</p>

    <div v-else-if="draft" class="flex flex-col gap-5">
      <!-- Честная плашка ограничений MVP-редактора -->
      <B24Alert
        color="air-primary-warning"
        title="Возможности редактора"
        description="Сейчас можно менять заголовок, тексты вопросов и стадии-триггеры. Добавление/удаление вопросов и опций, смена метрики — в следующей версии конструктора."
      />

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
