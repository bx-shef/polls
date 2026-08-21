<script setup lang="ts">
// Хендлер плейсмента CRM_DEAL_DETAIL_ACTIVITY (#17): виджет в карточке сделки — ручной запуск
// опроса (охват на ВСЕХ тарифах). В iframe: initializeB24Frame() → auth + ID сделки (placement
// options) → по кнопке POST /api/b24/deal-invite → ссылка-приглашение /s/:key?token=…
// Только клиент (iframe нет на SSR).
//
// ⚠️ Виджет открывается ТРЕМЯ способами, и это разные ситуации:
//  1. из карточки сделки — приглашения ещё нет, менеджер жмёт «Создать ссылку»;
//  2. кнопкой «Отправить приглашение» на деле в таймлайне — приглашение УЖЕ выписано автотриггером,
//     и его токен приезжает в параметрах. Тогда показываем ГОТОВУЮ ссылку, а не выписываем новую:
//     иначе у клиента окажутся две, и первая умрёт при ответе по второй — дубль, сделанный руками
//     менеджера ровно после того, как мы избавились от машинных (#138);
//  3. кнопкой «Открыть результат» на деле-РЕЗУЛЬТАТЕ (#18) — клиент уже ответил, и в параметрах едет
//     идентификатор записи. Эта ветка проверяется ПЕРВОЙ: спутав её со второй, виджет предложил бы
//     выписать новое приглашение только что ответившему клиенту.
import { initializeB24Frame } from '@bitrix24/b24jssdk'
// Текст ошибки берёт ядровая `serverMessage` (одна на всё приложение). Своя копия здесь падала на
// `statusMessage` — служебную АНГЛИЙСКУЮ строку h3, которую сотрудник в карточке сделки видеть не должен.
import { serverMessage } from '~core/client/server-message'
// Разбор параметров открытия — чистой функцией в ядре: их два способа, и перепутать их значит
// выписать ВТОРОЕ приглашение на ту же сделку.
import {
  hasIssuedInvitation, hasResultRequest, issuedLinkView, readLinkVerdict, readWidgetParams, type LinkVerdict
} from '~core/client/widget-params'
// Псевдоним намеренный: автоимпортируемый компонент называется так же (`ResultView.vue`), и
// одноимённый type-only импорт читается как использование значения из него.
import type { ResultView as ResultViewData } from '~core/domain/result-view'
import { INVITATION_TOKEN_PARAM, surveyPath } from '~core/client/invitation-link'

type FrameAuth = { domain: string; member_id: string; access_token: string }

const serverError = (e: unknown, fallback: string): string => serverMessage(e) ?? fallback

const phase = ref<'init' | 'ready' | 'done' | 'error' | 'result'>('init')
/** Готовый результат клиента — виджет открыт кнопкой «Открыть результат» на деле-результате (#18). */
const result = ref<ResultViewData | undefined>()
/**
 * Сервер ответил «приглашение по этой сделке уже отправлено» (#176). Отдельное состояние, а не текст
 * ошибки: человек ничего не сделал не так, и вести его надо в таймлайн сделки, а не в «попробуйте
 * снова». Рядом остаётся осознанное «всё равно создать новую» — ручной путь это действие человека,
 * который смотрит на карточку, и запрещать его насовсем неправильно.
 */
const alreadyInvited = ref(false)
/**
 * Ссылка выдана, а дела в таймлайне нет (портал отказал в создании). Говорим вслух: следующее
 * нажатие о такой ссылке не узнает, и ответ клиента её не закроет — то есть это ровно та «невидимая
 * вторая ссылка», ради которой затевался #176. Молчаливое «Ссылка готова» здесь было бы неправдой.
 */
const activityMissing = ref(false)
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
    // ⚠️ Результат проверяется ПЕРВЫМ, и порядок несущий: дело-результат живёт на той же сделке, что
    // и дело-приглашение. Спутав их, виджет предложил бы выписать НОВОЕ приглашение клиенту, который
    // только что ответил. Порядок закреплён структурным гардом (`test/tenant-routes.test.ts`).
    //
    // ⚠️ Прошлый результат гасим на КАЖДОМ открытии: если портал переиспользует уже открытый фрейм,
    // остаточное значение показало бы ответ ПРЕДЫДУЩЕГО клиента под текущей сделкой. Переиспользует
    // ли — вживую не сверено, и это отдельный пункт живого прогона.
    result.value = undefined
    if (hasResultRequest(params)) {
      message.value = 'Загружаем результат…'
      await loadResult(params.responseId)
      return
    }
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
 * Прочитать результат по идентификатору записи. Портал подтверждает сервер — тем же фрейм-токеном,
 * что и остальные экраны; здесь показывается то, что он вернул.
 */
async function loadResult(responseId: string): Promise<void> {
  if (!auth) {
    // ⚠️ Не голый `return`: он оставил бы экран в вечном «Загружаем результат…». Сегодня сюда не
    // попасть (единственный вызов идёт после присвоения `auth`), но защитная ветка, ведущая в
    // тупик, — плохой сосед для фазовой машины.
    phase.value = 'error'
    message.value = 'Не удалось открыть виджет. Обновите страницу и откройте его заново из карточки сделки.'
    return
  }
  try {
    const r = await $fetch<{ ok: boolean; view?: ResultViewData; error?: string }>('/api/b24/result', {
      method: 'POST',
      body: { DOMAIN: auth.domain, member_id: auth.member_id, AUTH_ID: auth.access_token, responseId }
    })
    if (!r.ok || !r.view) throw new Error(r.error ?? 'сервер не вернул результат')
    result.value = r.view
    phase.value = 'result'
  } catch (e) {
    phase.value = 'error'
    message.value = serverError(e, 'Не удалось открыть результат. Попробуйте ещё раз.')
  }
}

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

/**
 * Выписать ссылку. `force` — осознанный обход дедупа, и он уходит ТОЛЬКО вторым нажатием: первое
 * всегда идёт без него, чтобы сервер успел ответить «уже приглашали».
 *
 * ⚠️ Здесь была дыра. Кнопка «Создать новую ссылку» рядом с готовой ссылкой слала `force` СРАЗУ, а
 * рисуется она при вердикте `unknown` — когда проверку ссылки просто не удалось выполнить (429 от
 * портала, сбой сети) и ссылка «скорее всего рабочая». То есть дедуп выключался ровно в том случае,
 * ради которого разбор вердикта сделан fail-open, и одно нажатие давало вторую ссылку при живом
 * открытом деле — дефект #176 целиком, только через другую кнопку.
 */
async function launch(force = false, reason: 'dedup' | 'reissue' = 'dedup') {
  if (!auth || !dealId.value) return
  phase.value = 'init'
  alreadyInvited.value = false
  activityMissing.value = false
  message.value = force ? 'Создаём новую ссылку…' : 'Создаём ссылку…'
  // Метка относится к КОНКРЕТНОЙ ссылке: оставшись от прошлой, «Скопировано» соврало бы про новую.
  copyLabel.value = COPY_IDLE
  try {
    const r = await $fetch<{
      ok: boolean
      url?: string
      error?: string
      alreadyInvited?: boolean
      activityMissing?: boolean
    }>(
      '/api/b24/deal-invite',
      {
        method: 'POST',
        body: {
          DOMAIN: auth.domain,
          member_id: auth.member_id,
          AUTH_ID: auth.access_token,
          dealId: dealId.value,
          // Флаг уходит ТОЛЬКО по второму нажатию — тому, что человек делает, уже зная про первое
          // приглашение. Слать его всегда значило бы вернуть дефект #176 под другим именем.
          // `forceReason` нужен логу: без него законная перевыписка мёртвой ссылки смешалась бы с
          // настоящим обходом дедупа, и живой прогон не смог бы измерить ни то, ни другое.
          ...(force ? { force: true, forceReason: reason } : {})
        }
      }
    )
    if (!r.ok && r.alreadyInvited) {
      // ⚠️ Это не ошибка: кнопка остаётся на месте, но подписана честно, а текст ведёт к конкретному
      // делу в таймлайне, где ссылка уже есть.
      alreadyInvited.value = true
      canReissue.value = true
      // ⚠️ Уже показанную ссылку НЕ прячем: сюда можно прийти из таймлайна, где человек за ней и
      // открыл виджет. Уводить его в пустой экран из-за ответа «уже приглашали» — потеря того, за чем
      // пришли.
      phase.value = link.value ? 'done' : 'ready'
      message.value = r.error ?? 'Приглашение по этой сделке уже отправлено — оно в таймлайне сделки.'
      return
    }
    if (!r.ok || !r.url) throw new Error(r.error ?? 'сервер не вернул ссылку')
    link.value = r.url
    canReissue.value = false
    activityMissing.value = r.activityMissing === true
    phase.value = 'done'
    message.value = activityMissing.value
      ? 'Ссылка готова, но записать её в таймлайн сделки не удалось. Скопируйте и отправьте клиенту — и учтите, что в карточке её не будет:'
      : 'Ссылка готова. Скопируйте её и отправьте клиенту:'
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
    <ResultView v-else-if="phase === 'result' && result" :view="result" />
    <template v-else>
      <p class="mb-3 text-sm text-gray-600 dark:text-gray-300">{{ message }}</p>
      <B24Button
        v-if="phase === 'ready'"
        :color="alreadyInvited ? 'air-secondary' : 'air-primary'"
        :label="alreadyInvited ? 'Всё равно создать новую ссылку' : 'Создать ссылку на опрос'"
        :disabled="!dealId"
        @click="launch(alreadyInvited, 'dedup')"
      />
      <div v-if="phase === 'done'" class="mt-2 flex flex-col gap-2">
        <a :href="link" target="_blank" class="break-all text-indigo-600 underline dark:text-indigo-400">{{ link }}</a>
        <div class="flex flex-wrap gap-2">
          <B24Button color="air-secondary" :label="copyLabel" @click="copyLink" />
          <B24Button
            v-if="canReissue"
            color="air-tertiary"
            :label="alreadyInvited ? 'Всё равно создать новую ссылку' : 'Создать новую ссылку'"
            :disabled="!dealId"
            @click="launch(alreadyInvited, 'reissue')"
          />
        </div>
      </div>
    </template>
  </main>
</template>
