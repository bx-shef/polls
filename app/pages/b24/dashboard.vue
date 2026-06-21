<script setup lang="ts">
// Хендлер плейсмента CRM_ANALYTICS_MENU (#17/#47): дашборд в меню CRM-аналитики портала.
// Страница ВСЕГДА открывается в iframe Bitrix24 → выполняет handshake фрейма:
//   initializeB24Frame() → getAuthData() → POST /api/b24/session (ядро сверит токен через app.info
//   + резолвит member_id из таблицы portal) → cookie polls_portal → переход на дашборд /d/:key,
//   который теперь проходит requirePortalSession. Только клиент (iframe нет на SSR).
import { initializeB24Frame } from '@bitrix24/b24jssdk'

// Демо-опрос по умолчанию (до выбора опроса в аналитике — отдельная задача).
const DEFAULT_SURVEY = 'csat_postdeal'

const phase = ref<'auth' | 'error'>('auth')
const message = ref('Авторизация в портале…')

onMounted(async () => {
  try {
    const b24 = await initializeB24Frame()
    const auth = b24.auth.getAuthData()
    if (!auth) throw new Error('нет данных авторизации фрейма')
    // Минт сессии портала (ядро: SSRF-allowlist домена → app.info → сверка member_id → cookie).
    await $fetch('/api/b24/session', {
      method: 'POST',
      body: { DOMAIN: auth.domain, member_id: auth.member_id, AUTH_ID: auth.access_token }
    })
    // Cookie polls_portal установлена → дашборд пройдёт авторизацию.
    await navigateTo(`/d/${DEFAULT_SURVEY}`)
  } catch (e) {
    phase.value = 'error'
    message.value = `Не удалось авторизоваться в портале: ${(e as Error).message}`
  }
})
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-xl items-center justify-center p-6">
    <B24Alert v-if="phase === 'error'" color="air-primary-alert" :title="message" />
    <p v-else class="text-sm text-gray-500 dark:text-gray-400">{{ message }}</p>
  </main>
</template>
