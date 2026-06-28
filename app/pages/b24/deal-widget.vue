<script setup lang="ts">
// Хендлер плейсмента CRM_DEAL_DETAIL_ACTIVITY (#17): виджет в карточке сделки — ручной запуск
// опроса (охват на ВСЕХ тарифах). В iframe: initializeB24Frame() → auth + ID сделки (placement
// options) → по кнопке POST /api/b24/deal-invite → ссылка-приглашение /s/:key?token=…
// Только клиент (iframe нет на SSR).
import { initializeB24Frame } from '@bitrix24/b24jssdk'

type FrameAuth = { domain: string; member_id: string; access_token: string }

const phase = ref<'init' | 'ready' | 'done' | 'error'>('init')
const message = ref('Загрузка…')
const link = ref('')
const dealId = ref<number | undefined>()
let auth: FrameAuth | undefined

onMounted(async () => {
  try {
    const b24 = await initializeB24Frame()
    const a = b24.auth.getAuthData()
    if (!a) throw new Error('нет данных авторизации')
    auth = { domain: a.domain, member_id: a.member_id, access_token: a.access_token }
    // ID сделки из параметров плейсмента ({ID: '759'}).
    const opts = b24.placement.options
    const id = Number(opts?.ID)
    dealId.value = Number.isInteger(id) && id > 0 ? id : undefined
    phase.value = 'ready'
    message.value = dealId.value ? 'Готово к запуску опроса по этой сделке.' : 'Откройте виджет из карточки сделки.'
  } catch (e) {
    phase.value = 'error'
    message.value = `Ошибка инициализации: ${(e as Error).message}`
  }
})

async function launch() {
  if (!auth || !dealId.value) return
  phase.value = 'init'
  message.value = 'Создаём приглашение…'
  try {
    const r = await $fetch<{ ok: boolean; url?: string; error?: string }>('/api/b24/deal-invite', {
      method: 'POST',
      body: { DOMAIN: auth.domain, member_id: auth.member_id, AUTH_ID: auth.access_token, dealId: dealId.value }
    })
    if (!r.ok || !r.url) throw new Error(r.error ?? 'не удалось')
    link.value = r.url
    phase.value = 'done'
    message.value = 'Ссылка на опрос создана — отправьте её клиенту:'
  } catch (e) {
    phase.value = 'error'
    message.value = `Не удалось создать опрос: ${(e as Error).message}`
  }
}
</script>

<template>
  <main class="mx-auto max-w-xl p-4">
    <B24Alert v-if="phase === 'error'" color="air-primary-alert" :title="message" />
    <template v-else>
      <p class="mb-3 text-sm text-gray-600 dark:text-gray-300">{{ message }}</p>
      <B24Button
        v-if="phase === 'ready'"
        color="air-primary"
        label="Создать опрос по сделке"
        :disabled="!dealId"
        @click="launch"
      />
      <div v-if="phase === 'done'" class="mt-2">
        <a :href="link" target="_blank" class="break-all text-indigo-600 underline dark:text-indigo-400">{{ link }}</a>
      </div>
    </template>
  </main>
</template>
