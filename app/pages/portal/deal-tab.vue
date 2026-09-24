<script setup lang="ts">
import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { readFramePass } from '~/utils/frame-auth'
import { dealIdFrom } from '~/utils/placement'

/**
 * The app's tab inside a deal card: pick a survey, get a link, copy it.
 *
 * Живёт внутри iframe портала, поэтому здесь ТОЛЬКО компоненты `b24ui` — правило проекта.
 * Публичная страница анкеты устроена наоборот и своей вёрсткой: она вне портала.
 *
 * ⚠ Страница НЕ ходит в портал за данными сама, хотя из фрейма это возможно. Выпуск ссылки —
 * это три шага, которые должны случиться в одном порядке и с записью в нашу базу (кэш схемы,
 * элемент смарт-процесса, хеш токена). Половина из них браузеру недоступна, а разорвать их
 * между браузером и сервером значит получить ссылку, ведущую в никуда, при первом же обрыве связи.
 * Поэтому наружу уходит только пропуск — `member_id` и фреймовый токен, — а работает сервер.
 */

interface Survey {
  code: string
  version: number
  title: string
}

/**
 * Отказы выпуска, у каждого свой текст.
 *
 * «Попробуйте ещё раз» на отказ в доступе — обман: сколько ни пробуй, чужую сделку не увидишь.
 * Человек должен понимать, что именно случилось, иначе он будет звонить в поддержку.
 */
const REFUSALS: Record<string, string> = {
  'survey-gone': 'Этот опрос сняли с публикации, пока вкладка была открыта. Обновите страницу.',
  'deal-denied': 'У вас нет доступа к этой сделке — ссылку по ней выпустить нельзя.',
  'not-provisioned': 'Приложение ещё настраивается: смарт-процессы опросов на портале не найдены.',
}

definePageMeta({ layout: 'portal' })

const route = useRoute()

const loading = ref(true)
const issuing = ref('')
const failure = ref('')
const notProvisioned = ref(false)
const surveys = ref<Survey[]>([])
const dealId = ref<number | null>(null)
const issued = ref<{ url: string, expiresAt: string } | null>(null)
const copied = ref(false)

/**
 * Связь с порталом. `undefined` ровно до конца `onMounted`.
 *
 * Дальше в коде стоит `frame!`, и это не «а вдруг пронесёт»: обе функции, которые его читают,
 * достижимы только из шаблона, а шаблон до конца `onMounted` показывает скелет — `loading`
 * снимается в `finally`, то есть после присваивания. Если `initializeB24Frame` упал, кнопок
 * нет вовсе: на экране карточка отказа. Убрать `finally` или отрисовать кнопки при `loading` —
 * и это перестанет быть правдой; поэтому здесь и написано, чем именно держится.
 */
let frame: B24Frame | undefined

useHead({ title: 'Опросы' })

onMounted(async () => {
  try {
    frame = await initializeB24Frame()
    dealId.value = dealIdFrom(frame.placement.options, route.query)
    await loadSurveys()
  }
  catch {
    failure.value = 'Не удалось связаться с порталом. Обновите страницу.'
  }
  finally {
    loading.value = false
  }
})

/**
 * Пропуск, который сервер проверит у портала: сами по себе эти два значения ничего не дают.
 *
 * ⚠ Имена полей читает `readFramePass`, а не этот файл. Здесь стояло `auth.memberId` —
 * а SDK отдаёт `member_id`, и из-за индексной сигнатуры `[key: string]: any` в его типе
 * это компилировалось молча. На сервер уезжало `memberId: undefined`, то есть вкладка
 * не работала бы ни разу при полностью зелёном `pnpm check`.
 */
function pass() {
  const parsed = readFramePass(frame!.auth.getAuthData())
  if (parsed === null) throw new Error('нет данных авторизации фрейма')
  return { memberId: parsed.memberId, authId: parsed.authId }
}

async function loadSurveys() {
  const result = await $fetch<{ ok: boolean, reason?: string, surveys?: Survey[] }>(
    '/api/portal/surveys',
    { method: 'POST', body: pass() },
  )
  if (!result.ok) {
    notProvisioned.value = result.reason === 'not-provisioned'
    return
  }
  surveys.value = result.surveys ?? []
}

async function issue(survey: Survey) {
  if (issuing.value !== '' || dealId.value === null) return
  issuing.value = survey.code
  failure.value = ''
  copied.value = false

  try {
    const result = await $fetch<{ ok: boolean, reason?: string, url?: string, expiresAt?: string }>(
      '/api/portal/issue',
      {
        method: 'POST',
        body: { ...pass(), dealId: dealId.value, surveyCode: survey.code, surveyVersion: survey.version },
      },
    )
    if (result.ok && result.url !== undefined) {
      issued.value = { url: result.url, expiresAt: result.expiresAt ?? '' }
      return
    }
    failure.value = REFUSALS[result.reason ?? ''] ?? 'Не удалось выпустить ссылку. Попробуйте ещё раз.'
  }
  catch {
    failure.value = 'Не удалось выпустить ссылку. Попробуйте ещё раз.'
  }
  finally {
    issuing.value = ''
  }
}

async function copyLink() {
  if (issued.value === null) return
  try {
    await navigator.clipboard.writeText(issued.value.url)
    copied.value = true
  }
  catch {
    // Буфер обмена недоступен — в iframe это бывает. Ссылка и так на экране и выделяется
    // руками, поэтому это не ошибка, просто кнопка ничего не даёт.
    copied.value = false
  }
}

const expiresLabel = computed(() => {
  if (issued.value === null || issued.value.expiresAt === '') return ''
  return new Date(issued.value.expiresAt).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
})
</script>

<template>
  <B24DashboardPanel id="deal-tab">
    <template #header>
      <B24DashboardNavbar
        :toggle="false"
        title="Опросы"
      />
    </template>

    <template #body>
      <B24Skeleton
        v-if="loading"
        class="h-24 w-full"
      />

      <B24Alert
        v-else-if="failure"
        color="air-primary-alert"
        title="Не получилось"
        :description="failure"
      />

      <B24Alert
        v-else-if="notProvisioned"
        color="air-primary-warning"
        title="Приложение ещё настраивается"
        description="Смарт-процессы опросов на портале не найдены. Обычно это значит, что установка не завершилась — переустановите приложение или обратитесь к администратору."
      />

      <B24Alert
        v-else-if="dealId === null"
        color="air-primary-warning"
        title="Сделка не определена"
        description="Откройте вкладку из карточки сделки — ссылка выпускается для конкретной сделки."
      />

      <B24Alert
        v-else-if="surveys.length === 0"
        color="air-secondary-accent"
        title="Опросов пока нет"
        description="Выпускать нечего: на портале нет ни одной опубликованной анкеты. Они появляются после переноса из старого решения."
      />

      <template v-else>
        <div v-if="issued === null">
          <p class="mb-3">
            Выберите опрос — ссылка выпустится для этой сделки и будет действовать 30 дней.
          </p>
          <div class="flex flex-col gap-2">
            <B24Button
              v-for="survey in surveys"
              :key="`${survey.code}:${survey.version}`"
              color="air-primary"
              :loading="issuing === survey.code"
              :disabled="issuing !== ''"
              @click="issue(survey)"
            >
              {{ survey.title }}
            </B24Button>
          </div>
        </div>

        <div v-else>
          <B24Alert
            color="air-primary-success"
            title="Ссылка выпущена"
            :description="expiresLabel ? `Действует до ${expiresLabel}. Ответить по ней можно один раз.` : 'Ответить по ней можно один раз.'"
            class="mb-3"
          />
          <B24Input
            :model-value="issued.url"
            readonly
            class="mb-2 w-full"
          />
          <div class="flex gap-2">
            <B24Button
              color="air-primary"
              @click="copyLink"
            >
              {{ copied ? 'Скопировано' : 'Скопировать' }}
            </B24Button>
            <B24Button
              color="air-secondary-no-accent"
              @click="issued = null"
            >
              Выпустить ещё одну
            </B24Button>
          </div>
        </div>
      </template>
    </template>
  </B24DashboardPanel>
</template>
