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

/** Выпущенная ссылка, как её отдаёт сервер: состояние уже посчитано там. */
interface IssuedLink {
  itemId: number
  title: string
  code: string
  version: number
  state: 'active' | 'completed' | 'revoked' | 'expired'
  expiresAt: string
  completedAt: string
  score: number | null
}

/**
 * Подписи состояний. Словами, а не кодом: вкладку читает менеджер, а не разработчик.
 *
 * ⚠ «Отозвана» и «Истекла» разведены намеренно. Обе означают «не откроется», но первая —
 * это действие человека, а вторая — течение времени, и при разборе «почему клиент не ответил»
 * разница между ними и есть весь ответ.
 */
// ⚠ `as const satisfies`, а не аннотация типом: `color` должен остаться литералом, иначе
// `B24Badge` не примет строку — у него цвет это перечисление ролей, а не любой текст.
// Правило проекта «цвет задаётся именем роли» здесь проверяется компилятором.
const STATES = {
  active: { label: 'Ждём ответа', color: 'air-primary' },
  completed: { label: 'Пройдена', color: 'air-primary-success' },
  revoked: { label: 'Отозвана', color: 'air-secondary' },
  expired: { label: 'Истекла', color: 'air-secondary' },
} as const satisfies Record<IssuedLink['state'], { label: string, color: string }>

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
const links = ref<IssuedLink[]>([])
const busyItem = ref(0)

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
    // Список и выбор грузятся вместе: это два независимых обращения, и ждать их по очереди
    // значит показывать скелет вдвое дольше без единой причины.
    await Promise.all([loadSurveys(), loadLinks()])
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

/**
 * Список уже выпущенных ссылок.
 *
 * ⚠ Отказ загрузки списка НЕ мешает выпустить новую. Список — это память о прошлом,
 * а выпуск — работа, которую человек пришёл сделать: уронив вкладку целиком из-за первого,
 * мы отняли бы второе.
 */
async function loadLinks() {
  if (dealId.value === null) return
  try {
    const result = await $fetch<{ ok: boolean, links?: IssuedLink[] }>(
      '/api/portal/links',
      { method: 'POST', body: { ...pass(), dealId: dealId.value } },
    )
    links.value = result.ok ? result.links ?? [] : []
  }
  catch {
    links.value = []
  }
}

/**
 * Погасить ссылку.
 *
 * ⚠ Список перечитывается С СЕРВЕРА, а не правится на месте. Состояние ссылки живёт
 * на портале, и «поправить у себя» значит показать то, чего там может не быть: отзыв мог
 * не пройти наполовину, а за время, пока вкладка открыта, ссылку могли пройти.
 */
async function revoke(link: IssuedLink) {
  if (busyItem.value !== 0 || dealId.value === null) return
  busyItem.value = link.itemId
  failure.value = ''

  try {
    const result = await $fetch<{ ok: boolean, reason?: string }>(
      '/api/portal/revoke',
      { method: 'POST', body: { ...pass(), dealId: dealId.value, itemId: link.itemId } },
    )
    if (!result.ok) failure.value = REFUSALS[result.reason ?? ''] ?? 'Не удалось отозвать ссылку. Попробуйте ещё раз.'
    await loadLinks()
  }
  catch {
    failure.value = 'Не удалось отозвать ссылку. Попробуйте ещё раз.'
  }
  finally {
    busyItem.value = 0
  }
}

/**
 * Перевыпустить: погасить прежнюю и выпустить новую по той же анкете.
 *
 * ⚠ Именно в этом порядке. Клиент потерял письмо — и если сначала выпустить, а потом гасить,
 * то между двумя вызовами по сделке живут ДВЕ рабочие одноразовые ссылки, и какая из них
 * «настоящая», не знает никто. Сорвись гашение — останется одна лишняя живая ссылка;
 * сорвись выпуск после гашения — не останется ни одной, но это видно сразу и чинится кнопкой.
 */
async function reissue(link: IssuedLink) {
  const survey = surveys.value.find(item => item.code === link.code && item.version === link.version)
  if (survey === undefined) {
    failure.value = 'Эту анкету сняли с публикации — перевыпустить по ней нельзя. Выберите другую.'
    return
  }

  await revoke(link)
  if (failure.value !== '') return
  await issue(survey)
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
      await loadLinks()
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

/** Дата словами. Пусто — портал её не прислал, и выдумывать нечего. */
function dateLabel(raw: string): string {
  if (raw === '') return ''
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
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
        <!--
          ⚠ Список стоит ПЕРВЫМ и показывается всегда, даже когда только что выпустили новую.
          Ради него задача и заводилась: закрыл вкладку — и узнать, выпускал ли ты что-нибудь
          по этой сделке, было нельзя, а сам токен не покажется больше никогда.
        -->
        <div
          v-if="links.length > 0"
          class="mb-4"
        >
          <p class="mb-2 font-semibold">
            Выпущенные ссылки
          </p>
          <div class="flex flex-col gap-2">
            <B24Card
              v-for="link in links"
              :key="link.itemId"
              class="p-3"
            >
              <div class="flex flex-wrap items-center gap-2">
                <B24Badge :color="STATES[link.state].color">
                  {{ STATES[link.state].label }}
                </B24Badge>
                <span class="font-semibold">{{ link.title || link.code }}</span>
                <span class="text-sm opacity-70">
                  {{ link.state === 'completed'
                    ? `пройдена ${dateLabel(link.completedAt)}`
                    : dateLabel(link.expiresAt) ? `действует до ${dateLabel(link.expiresAt)}` : '' }}
                </span>
                <span
                  v-if="link.score !== null"
                  class="text-sm opacity-70"
                >
                  балл {{ link.score }}
                </span>
              </div>

              <div
                v-if="link.state === 'active'"
                class="mt-2 flex gap-2"
              >
                <B24Button
                  size="sm"
                  color="air-secondary-no-accent"
                  :loading="busyItem === link.itemId"
                  :disabled="busyItem !== 0 || issuing !== ''"
                  @click="revoke(link)"
                >
                  Отозвать
                </B24Button>
                <B24Button
                  size="sm"
                  color="air-secondary-accent"
                  :disabled="busyItem !== 0 || issuing !== ''"
                  @click="reissue(link)"
                >
                  Перевыпустить
                </B24Button>
              </div>
            </B24Card>
          </div>
        </div>

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
