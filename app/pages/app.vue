<script setup lang="ts">
import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { readFramePass } from '~/utils/frame-auth'
import { isPreview, portalGate } from '~/utils/in-portal'

/**
 * The app's own page: what the portal opens from the left menu.
 *
 * ⚠ Это адрес из поля «Ссылка на приложение» в кабинете разработчика. Раньше туда указывал
 * корень — а корень теперь лендинг, и портал открывал бы сотруднику маркетинговую страницу
 * вместо приложения. Разводить их обязательно: у них разные читатели, разная политика
 * безопасности и разное отношение к поисковой выдаче.
 *
 * Здесь НЕ дашборд. Отчёты — отдельная большая часть, которой пока нет, и рисовать вместо
 * неё красивые пустые карточки значит обещать то, чего приложение не делает. Показываем
 * ровно то, что правда: настроен ли портал, сколько анкет опубликовано и где именно
 * сотрудник эту работу делает.
 */

definePageMeta({ layout: false })

interface Survey {
  code: string
  version: number
  title: string
}

const route = useRoute()
const resolved = ref(false)
const inPortal = ref(false)
const loading = ref(true)
const notProvisioned = ref(false)
const failure = ref('')
const surveys = ref<Survey[]>([])

let frame: B24Frame | undefined

useHead({
  title: 'Опросы клиентов',
  // ⚠ Служебная страница: в выдаче ей делать нечего. Дублируем заголовок `X-Robots-Tag`
  // мета-тегом — заголовок ставит сервер, и при смене раздачи он теряется молча.
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})

const gate = computed(() => portalGate({
  resolved: resolved.value,
  inPortal: inPortal.value,
  preview: isPreview(route.query.preview),
}))

onMounted(async () => {
  try {
    frame = await initializeB24Frame()
    inPortal.value = true
  }
  catch {
    // Не внутри портала. Это не ошибка — это единственный способ узнать, где мы.
    inPortal.value = false
  }
  finally {
    resolved.value = true
  }

  if (!inPortal.value) {
    loading.value = false
    return
  }

  try {
    await loadSurveys()
  }
  catch {
    failure.value = 'Не удалось получить список опросов с портала. Обновите страницу.'
  }
  finally {
    loading.value = false
  }
})

async function loadSurveys() {
  const pass = readFramePass(frame!.auth.getAuthData())
  if (pass === null) throw new Error('нет данных авторизации фрейма')

  const result = await $fetch<{ ok: boolean, reason?: string, surveys?: Survey[] }>(
    '/api/portal/surveys',
    { method: 'POST', body: { memberId: pass.memberId, authId: pass.authId } },
  )
  if (!result.ok) {
    notProvisioned.value = result.reason === 'not-provisioned'
    return
  }
  surveys.value = result.surveys ?? []
}
</script>

<template>
  <B24App>
    <div class="p-4">
      <B24Skeleton
        v-if="gate === 'checking' || loading"
        class="h-32 w-full"
      />

      <B24Alert
        v-else-if="gate === 'outside'"
        color="air-secondary-accent"
        title="Откройте приложение из Битрикс24"
        description="Эта страница работает только внутри портала: снаружи у неё нет доступа ни к вашим опросам, ни к CRM. Найдите «Опросы клиентов» в левом меню портала."
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
        description="Смарт-процессы опросов на портале не найдены. Обычно это значит, что установка не завершилась — переустановите приложение от имени администратора."
      />

      <template v-else>
        <h1 class="mb-2 text-xl font-semibold">
          Опросы клиентов
        </h1>
        <p class="mb-4">
          Опрос уходит клиенту ссылкой, он проходит его с телефона за пару минут без
          регистрации, а ответ возвращается в карточку сделки: балл, текст целиком
          и запись в истории.
        </p>

        <B24Alert
          v-if="surveys.length === 0"
          color="air-secondary-accent"
          title="Опубликованных анкет пока нет"
          description="Анкеты живут в смарт-процессе «Шаблон опроса» на вашем портале. Пока в нём нет ни одной опубликованной версии, выпускать нечего."
          class="mb-4"
        />
        <template v-else>
          <p class="mb-2 font-medium">
            Готовы к выпуску:
          </p>
          <ul class="mb-4 list-inside list-disc">
            <li
              v-for="survey in surveys"
              :key="`${survey.code}:${survey.version}`"
            >
              {{ survey.title }} <span class="opacity-60">· версия {{ survey.version }}</span>
            </li>
          </ul>
        </template>

        <B24Alert
          color="air-secondary"
          title="Где выпускать ссылку"
          description="Откройте любую сделку и перейдите на вкладку «Опросы» в её карточке. Ссылка выпускается для конкретной сделки — так ответ и попадает именно в неё."
        />
      </template>
    </div>
  </B24App>
</template>
