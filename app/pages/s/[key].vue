<script setup lang="ts">
import type { PublicVersion } from '~core/domain/schema'
import { INVITATION_TOKEN_PARAM, hasInvitationTokenAttempt, readInvitationToken } from '~core/client/invitation-link'
import { serverMessage } from '~core/client/server-message'

// Маршрут прохождения опроса контура A: /s/:key. Оркеструет фазы (intro→survey→thanks)
// поверх композабла useSurvey (обёртка ядрового SurveyFill).
//
// Версию грузим через useAsyncData: SSR-рендер + payload-трансфер (без двойного fetch при
// гидрации) + автоматический рефетч при client-навигации на другой :key (watch). Ошибку
// (404/сеть) useAsyncData ловит сам — в setup исключение не всплывает (нет 500 на SSR).
// Ремоунт при смене опроса (/s/A → /s/B): иначе Nuxt переиспользует инстанс страницы и
// onMounted (а с ним hydrate) не отрабатывает повторно. С ремоунтом — свежий setup + onMounted.
definePageMeta({ key: (route) => route.path })

// В индекс этой странице не надо: у контура A ссылка одноразовая, у дашборда без сессии
// портала виден только экран отказа. `robots.txt` это уже просит — здесь дублируем на
// уровне страницы, потому что robots.txt краулер вправе проигнорировать.
useSeoMeta({ robots: 'noindex, nofollow' })

const route = useRoute()
const surveyKey = computed(() => String(route.params.key))

// Ключ per-опрос: при ремоунте — свежий fetch, без кеша чужого опроса под общим ключом.
const { data, error } = await useAsyncData(
  `survey:${surveyKey.value}`,
  () => $fetch<{ ok: boolean; version: PublicVersion }>(`/api/survey/${surveyKey.value}/current`)
)

// Токен приглашения из ссылки (`?token=…`). Имя параметра и правило разбора — в общем модуле:
// собирает ссылку сервер, читает клиент, и разъехаться этим двоим нельзя.
const invitationToken = computed(() => readInvitationToken(route.query[INVITATION_TOKEN_PARAM]))
// Токен в ссылке есть, но прочитать его нельзя (например `?token=a&token=b`). Молча продолжать
// нельзя: ответ ушёл бы без привязки к сделке и никто бы не узнал.
const brokenToken = computed(() =>
  !invitationToken.value && hasInvitationTokenAttempt(route.query[INVITATION_TOKEN_PARAM]))

/**
 * Годность ссылки проверяем ОТДЕЛЬНЫМ запросом и ДО заполнения.
 *
 * ⚠️ Проверка идёт и на SSR — намеренно. Сделай её только в `onMounted`, и человек с мёртвой
 * ссылкой сначала увидел бы интро, а потом отказ: мигание, за которое он успевает нажать «Начать».
 * Токен в payload при этом не «утекает» — он и так в адресной строке этой же страницы.
 *
 * Ключ БЕЗ токена: иначе он попал бы в разметку отдельным полем, а пользы от этого ноль — на
 * странице всегда ровно один токен.
 */
// Тело ответа не нужно: годность выражается кодом, а всё остальное сервер наружу не отдаёт.
const { error: linkError } = await useAsyncData(
  `invitation:${surveyKey.value}`,
  () => invitationToken.value
    ? $fetch<{ ok: boolean }>(`/api/survey/${surveyKey.value}/invitation`, {
      query: { [INVITATION_TOKEN_PARAM]: invitationToken.value }
    })
    : Promise.resolve(null)
)

const { phase, version, view, errorMsg, submitting, reset, start, hydrate, rejectLink, selectOption, setOther, setText, back, next } =
  useSurvey()

// Прокидываем результат загрузки в композабл. watch immediate срабатывает СИНХРОННО в setup
// (до onMounted) → к моменту onMounted phase='intro', version заполнен.
watch([data, error], () => reset(data.value?.version ?? null, error.value ?? undefined), { immediate: true })

/**
 * Негодная ссылка перебивает интро — но только если сам опрос открылся: «опрос не найден» важнее и
 * точнее, чем «ссылка не действует».
 *
 * ⚠️ **Транзиентный отказ проверки НЕ закрывает опрос.** Предпросмотр — это удобство, а не гейт:
 * настоящую проверку делает `consume` на отправке, и обойти её отсюда нельзя. Значит икота БД (500)
 * или обрыв сети не должны отнимать у человека возможность ответить: он проходит опрос, а вердикт
 * по ссылке всё равно вынесет сервер на «Отправить». Блокируем только на ОПРЕДЁЛЕННОМ отказе —
 * 403 (нет/протух/использована) и 409 (чужой опрос / опрос переиздан).
 */
const DEFINITIVE_REJECTIONS = [403, 409]

watch([linkError, () => phase.value, brokenToken], () => {
  if (phase.value === 'error') return
  if (brokenToken.value) {
    rejectLink('Ссылка повреждена — код приглашения в ней прочитать не удалось. Попросите новую ссылку у менеджера.')
    return
  }
  const status = (linkError.value as { statusCode?: number } | null)?.statusCode
  if (!linkError.value) return
  if (status === undefined || !DEFINITIVE_REJECTIONS.includes(status)) return
  rejectLink(serverMessage(linkError.value) ?? 'Попросите новую ссылку у менеджера.')
}, { immediate: true })

// Клиентская гидратация (после SSR, по факту монтирования): resume из localStorage +
// deep-link `?q=N` (1-based в URL → 0-based goTo). Зависит от порядка: watch выше уже отработал.
onMounted(() => {
  const q = route.query.q
  const idx = typeof q === 'string' && /^\d+$/.test(q) ? Math.max(0, parseInt(q, 10) - 1) : undefined
  hydrate(idx, invitationToken.value)
})
</script>

<template>
  <main class="flex min-h-screen items-center justify-center p-6">
    <p v-if="phase === 'loading'" class="text-gray-500 dark:text-gray-400">Загрузка…</p>

    <B24Alert
      v-else-if="phase === 'error'"
      color="air-primary-alert"
      :title="errorMsg"
      class="max-w-md"
    />

    <!--
      Ссылка негодна. Отдельный экран, а не «ошибка»: опрос жив, обновление страницы ничего не
      изменит. Заголовок нейтрален намеренно — «ссылка не действует» было бы неправдой для случая
      «опрос обновился»: сама ссылка там живая. Причину и действие пишет сервер: только он знает,
      истёк срок, переиздан опрос или ссылка от другого опроса.
    -->
    <B24Alert
      v-else-if="phase === 'link-invalid'"
      color="air-primary-warning"
      title="По этой ссылке опрос не открыть"
      :description="errorMsg"
      class="max-w-md"
    />

    <SurveyIntroScreen v-else-if="phase === 'intro' && version" :version="version" @start="start" />

    <SurveyQuestionScreen
      v-else-if="phase === 'survey' && view"
      :view="view"
      :submitting="submitting"
      :error-msg="errorMsg"
      @select="selectOption"
      @set-other="setOther"
      @set-text="setText"
      @next="next"
      @back="back"
    />

    <SurveyThanksScreen v-else-if="phase === 'thanks' && version" :version="version" />
  </main>
</template>
