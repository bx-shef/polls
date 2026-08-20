<script setup lang="ts">
// Хендлер плейсмента CRM_DEAL_DETAIL_ACTIVITY (#17): виджет в карточке сделки — ручной запуск
// опроса (охват на ВСЕХ тарифах). В iframe: initializeB24Frame() → auth + ID сделки (placement
// options) → по кнопке POST /api/b24/deal-invite → ссылка-приглашение /s/:key?token=…
// Только клиент (iframe нет на SSR).
//
// ⚠️ Виджет открывается ДВУМЯ способами, и это разные ситуации:
//  1. из карточки сделки — приглашения ещё нет, менеджер жмёт «Создать ссылку»;
//  2. кнопкой «Отправить приглашение» на деле в таймлайне — приглашение УЖЕ выписано автотриггером,
//     и его токен приезжает в параметрах. Тогда показываем ГОТОВУЮ ссылку, а не выписываем новую:
//     иначе у клиента окажутся две, и первая умрёт при ответе по второй — дубль, сделанный руками
//     менеджера ровно после того, как мы избавились от машинных (#138).
import { initializeB24Frame } from '@bitrix24/b24jssdk'
// Текст ошибки берёт ядровая `serverMessage` (одна на всё приложение). Своя копия здесь падала на
// `statusMessage` — служебную АНГЛИЙСКУЮ строку h3, которую сотрудник в карточке сделки видеть не должен.
import { serverMessage } from '~core/client/server-message'
// Разбор параметров открытия — чистой функцией в ядре: их два способа, и перепутать их значит
// выписать ВТОРОЕ приглашение на ту же сделку.
import { hasIssuedInvitation, issuedLinkView, readLinkVerdict, readWidgetParams, type LinkVerdict } from '~core/client/widget-params'
import { INVITATION_TOKEN_PARAM, surveyPath } from '~core/client/invitation-link'

type FrameAuth = { domain: string; member_id: string; access_token: string }

const serverError = (e: unknown, fallback: string): string => serverMessage(e) ?? fallback

const phase = ref<'init' | 'ready' | 'done' | 'error'>('init')
const message = ref('Загрузка…')
const link = ref('')
const dealId = ref<number | undefined>()
/** Показывать кнопку выписки рядом с уже готовой ссылкой (когда проверить её не удалось). */
const canReissue = ref(false)
let auth: FrameAuth | undefined

onMounted(async () => {
  try {
    const b24 = await initializeB24Frame()
    const a = b24.auth.getAuthData()
    if (!a) throw new Error('нет данных авторизации')
    auth = { domain: a.domain, member_id: a.member_id, access_token: a.access_token }
    const params = readWidgetParams(b24.placement.options)
    dealId.value = params.dealId
    if (hasIssuedInvitation(params)) {
      // Пришли по кнопке из таймлайна: ссылка уже есть. Берём ГОТОВУЮ строку, которую сервер записал
      // в тело дела, — тогда менеджер видит и копирует одну и ту же ссылку. Сборка из
      // `window.location.origin` — только фолбэк: сервер строит URL из настроенного домена приложения,
      // а виджет в iframe знает лишь свой origin, и за прокси/на алиасе домена это разные хосты.
      const issued = params.url ?? `${window.location.origin}${surveyPath(params.surveyKey, params.token)}`
      message.value = 'Проверяем ссылку…'
      const verdict = await checkLink(params.surveyKey, params.token)
      // Что показать — решает чистая функция ядра: три состояния ссылки × «известна ли сделка».
      const view = issuedLinkView(verdict, dealId.value !== undefined)
      link.value = view.showLink ? issued : ''
      canReissue.value = view.showReissue
      // `done` рисует ссылку, `ready` — кнопку выписки; при `unknown` нужны обе, поэтому фаза
      // выбирается по наличию ссылки, а кнопка — отдельным флагом.
      phase.value = view.showLink ? 'done' : 'ready'
      message.value = view.message
      return
    }
    phase.value = 'ready'
    message.value = dealId.value
      ? 'Нажмите «Создать ссылку на опрос» — получите ссылку, которую отправите клиенту.'
      : 'Не удалось определить сделку. Откройте виджет из карточки сделки.'
  } catch {
    phase.value = 'error'
    message.value = 'Не удалось открыть виджет. Обновите страницу и откройте его заново из карточки сделки.'
  }
})

/**
 * Жива ли уже выписанная ссылка. Спрашиваем тот же роут, что и страница опроса, — второго источника
 * правды о годности приглашения быть не должно. Правило разбора ответа — в ядре (`readLinkVerdict`,
 * fail-open: сбой проверки не повод объявлять ссылку мёртвой).
 */
async function checkLink(surveyKey: string, token: string): Promise<LinkVerdict> {
  try {
    const r = await $fetch.raw<unknown>(`/api/survey/${encodeURIComponent(surveyKey)}/invitation`, {
      query: { [INVITATION_TOKEN_PARAM]: token },
      ignoreResponseError: true
    })
    return readLinkVerdict(r.status, r._data)
  } catch {
    // Сеть недоступна — вердикта НЕТ. Не «жива» и не «мертва»: см. `LinkVerdict.state`.
    return { state: 'unknown' }
  }
}

/**
 * Копирование — основное действие менеджера: ссылку он всё равно понесёт в письмо или мессенджер.
 * Отказ буфера обмена (нет прав, старый браузер) не прячем: ссылка видна рядом и её можно выделить
 * руками, но молчаливая кнопка выглядела бы как поломка.
 */
const COPY_IDLE = 'Скопировать ссылку'
const copyLabel = ref(COPY_IDLE)
async function copyLink() {
  try {
    await navigator.clipboard.writeText(link.value)
    copyLabel.value = 'Скопировано'
  } catch {
    copyLabel.value = 'Не вышло — выделите ссылку вручную'
  }
}

async function launch() {
  if (!auth || !dealId.value) return
  phase.value = 'init'
  message.value = 'Создаём ссылку…'
  // Метка относится к КОНКРЕТНОЙ ссылке: оставшись от прошлой, «Скопировано» соврало бы про новую.
  copyLabel.value = COPY_IDLE
  try {
    const r = await $fetch<{ ok: boolean; url?: string; error?: string }>('/api/b24/deal-invite', {
      method: 'POST',
      body: { DOMAIN: auth.domain, member_id: auth.member_id, AUTH_ID: auth.access_token, dealId: dealId.value }
    })
    if (!r.ok || !r.url) throw new Error(r.error ?? 'сервер не вернул ссылку')
    link.value = r.url
    phase.value = 'done'
    message.value = 'Ссылка готова. Скопируйте её и отправьте клиенту:'
  } catch (e) {
    phase.value = 'error'
    // Сервер уже кладёт понятный текст с подсказкой (напр. «Опрос ещё не опубликован…») — показываем его.
    message.value = serverError(e, 'Не удалось создать ссылку. Проверьте доступ к сделке и попробуйте снова.')
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
        label="Создать ссылку на опрос"
        :disabled="!dealId"
        @click="launch"
      />
      <div v-if="phase === 'done'" class="mt-2 flex flex-col gap-2">
        <a :href="link" target="_blank" class="break-all text-indigo-600 underline dark:text-indigo-400">{{ link }}</a>
        <div class="flex flex-wrap gap-2">
          <B24Button color="air-secondary" :label="copyLabel" @click="copyLink" />
          <B24Button
            v-if="canReissue"
            color="air-tertiary"
            label="Создать новую ссылку"
            :disabled="!dealId"
            @click="launch"
          />
        </div>
      </div>
    </template>
  </main>
</template>
