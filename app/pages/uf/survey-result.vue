<script setup lang="ts">
import { MessageCommands, initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { readFramePass } from '~/utils/frame-auth'
import { isPreview, portalGate } from '~/utils/in-portal'
import { fieldContext } from '~/utils/placement'

/**
 * The «Результат опроса» field in the «Опрос» card: the survey result, in words.
 *
 * ⚠ ЭТО ПОЛЕ НАШЕГО ТИПА, а не вкладка. Портал открывает страницу во фрейме прямо внутри
 * карточки, на месте значения поля, — вместо двух JSON-полей, которые человек прочитать
 * не мог. Данные лежат в тех же JSON-полях элемента; страница их только показывает.
 *
 * ⚠ ТОЛЬКО ПОКАЗЫВАЕТ. Значение полю своего типа задаёт единственный вызов — `setValue`
 * из его же фрейма, — и здесь его нет. Поэтому поле нередактируемо по построению, в том числе
 * в режиме правки карточки: флага «только чтение» у обычных полей в REST нет, и это
 * единственный честный способ его получить (разбор — в `server/domain/portals/userfield-type.ts`).
 *
 * ⚠ ВЫСОТУ ПОЛЯ СТРАНИЦА ЗАДАЁТ САМА. Регистрация типа знает только начальную высоту, а число
 * вопросов у анкет разное: одна константа дала бы либо обрезанный результат, либо пустое место.
 *
 * ⚠ ПОКА ПОЛЕ СТОИТ НАД JSON-ПОЛЯМИ, а не вместо них: что портал рисует пустое поле своего типа,
 * живьём ещё не проверено. Разбор — `docs/PROCESS.md`, раздел 9.
 */

interface ResultAnswer {
  key: string
  title: string
  value: string
  scale: string
}

interface ResultSection {
  key: string
  title: string
  /** Балл уже по-русски («7,5»); пусто — балла нет. */
  score: string
  /** «по 1 из 5 вопросов» или «без оценки…»; пусто — пояснять нечего. */
  note: string
  answers: ResultAnswer[]
}

interface SurveyResultReply {
  ok: boolean
  reason?: string
  completed?: boolean
  /** Состояние приглашения, пока ответа нет: по нему выбирается фраза. */
  state?: string
  title?: string
  version?: number | null
  sections?: ResultSection[]
}

/** Отказы сервера — каждый своим текстом: чинятся они по-разному, а «обновите» помогает не всем. */
const REFUSALS: Record<string, string> = {
  'denied': 'У вас нет доступа к этому опросу.',
  'not-provisioned': 'Приложение ещё настраивается: смарт-процессы опросов на портале не найдены.',
  'foreign-card': 'Это поле показывает результат опроса и работает только в карточке «Опроса». Здесь его можно удалить из карточки.',
  // ⚠ Отдельно от `foreign-card`: это сбой встраивания на НАСТОЯЩЕЙ карточке, и совет
  // «удалите поле» здесь увёл бы администратора снимать исправный виджет.
  'no-owner': 'Портал не сообщил, в какой карточке открыто поле. Обновите карточку.',
  'no-item': 'Опрос не найден. Возможно, карточку удалили.',
}

/**
 * Что сказать, пока ответа нет, — по состоянию приглашения.
 *
 * ⚠ «Результат появится сразу после ответа» по истёкшей или отозванной ссылке — неправда:
 * ответа по ней уже не будет, и менеджер ждал бы его зря. Нашёл `/code-review`.
 */
const WAITING: Record<string, string> = {
  expired: 'Срок ссылки истёк, клиент не ответил. Чтобы спросить ещё раз, выпустите новую ссылку во вкладке «Опросы» сделки.',
  revoked: 'Ссылку отозвали — ответа по ней не будет.',
}
const WAITING_DEFAULT = 'Клиент ещё не прошёл опрос. Результат появится здесь сразу после ответа.'

/**
 * Ниже этого поле не сжимается, пикселей.
 *
 * Строка «клиент ещё не ответил» короче начальной высоты вчетверо; без нижней границы поле
 * схлопнулось бы до полоски, и соседние поля карточки прыгали бы при каждом открытии.
 */
const MIN_HEIGHT = 60

definePageMeta({ layout: 'portal' })

const route = useRoute()

const resolved = ref(false)
const inPortal = ref(false)
const loading = ref(true)
const failure = ref('')
const editing = ref(false)
const unsaved = ref(false)
const result = ref<SurveyResultReply | null>(null)

/** Корень содержимого — по нему меряется высота, см. `fit`. */
const root = ref<HTMLElement | null>(null)

const gate = computed(() => portalGate({
  resolved: resolved.value,
  inPortal: inPortal.value,
  preview: isPreview(route.query.preview),
}))

/** Связь с порталом. `undefined` — не внутри портала либо ещё не установлена. */
let frame: B24Frame | undefined

useHead({ title: 'Результат опроса' })

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

  if (frame === undefined) {
    loading.value = false
    return
  }

  const context = fieldContext(frame.placement.options)
  editing.value = context.editing

  try {
    if (context.itemId === null) {
      // ⚠ Новая карточка бывает только в режиме правки: там элемента ещё нет, и это не ошибка.
      // В режиме просмотра номер элемента обязан быть — его отсутствие значит, что портал
      // прислал контекст не в той форме, и «клиент ещё не прошёл опрос» было бы неправдой
      // на заполненном опросе. Нашёл `/review`.
      if (context.editing) unsaved.value = true
      else failure.value = 'Портал не сообщил, какой опрос открыт. Обновите карточку.'
      return
    }

    const pass = readFramePass(frame.auth.getAuthData())
    if (pass === null) throw new Error('нет данных авторизации фрейма')

    const reply = await $fetch<SurveyResultReply>('/api/portal/survey-result', {
      method: 'POST',
      body: {
        memberId: pass.memberId,
        authId: pass.authId,
        itemId: context.itemId,
        // Оба признака карточки — серверу: проверять, чья она, должен он, а не страница.
        entityId: context.entityId,
        entityTypeId: context.entityTypeId,
      },
    })
    if (!reply.ok) {
      failure.value = REFUSALS[reply.reason ?? ''] ?? 'Не удалось показать результат опроса. Обновите карточку.'
      return
    }
    result.value = reply
  }
  catch {
    failure.value = 'Не удалось получить результат опроса с портала. Обновите карточку.'
  }
  finally {
    loading.value = false
    await fit()
    watchSize()
  }
})

/** Слежка за размером содержимого. Снимается вместе со страницей. */
let observer: ResizeObserver | undefined
onBeforeUnmount(() => observer?.disconnect())

/**
 * Подогнать высоту поля под содержимое.
 *
 * ⚠ Мерим СВОЙ корень, а не документ. Оболочка портальных страниц стоит `min-h-screen`,
 * то есть документ во фрейме никогда не ниже самого фрейма: померив его (`fitWindow`), поле
 * могло бы только расти — после скелета в двести двадцать пикселей строка «ещё не ответил»
 * стояла бы над пустым местом.
 *
 * ⚠ Ширина — `'100%'`, как у `fitWindow`, а не числом. `resizeWindowAuto` шлёт ширину в пикселях,
 * и портал прибил бы фрейм к ширине первого показа: сузили слайдер — поле вылезло за колонку,
 * расширили — пустое место справа. Нашли `/review` и `/code-review`. Поэтому команда та же, что
 * у `fitWindow`, а высота — наша.
 */
async function fit() {
  if (frame === undefined || root.value === null) return
  await nextTick()
  const height = Math.max(root.value.scrollHeight, root.value.offsetHeight, MIN_HEIGHT)
  try {
    await frame.parent.message.send(MessageCommands.resizeWindow, { width: '100%', height, isSafely: true })
  }
  catch {
    // Портал не подогнал размер — поле останется начальной высоты, с прокруткой внутри.
    // Результат при этом виден целиком, так что это косметика, а не отказ.
  }
}

/**
 * Подгонять высоту и дальше — когда содержимое меняет размер.
 *
 * Ширина у поля резиновая, и при смене ширины карточки длинные ответы переносятся иначе:
 * подогнав высоту один раз, мы отправили бы их под внутреннюю прокрутку.
 */
function watchSize() {
  if (root.value === null || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => void fit())
  observer.observe(root.value)
}
</script>

<template>
  <div
    ref="root"
    class="p-3"
  >
    <!-- ⚠ ПЕРВЫМ, раньше скелета — по той же причине, что у вкладок: снаружи портала
         `loading` снимается сразу, но ветка ниже скелета показывала бы разговор не о том. -->
    <B24Alert
      v-if="gate === 'outside'"
      color="air-secondary-accent"
      title="Откройте карточку в Битрикс24"
      description="Это поле показывает результат опроса внутри карточки «Опроса» на портале. Отдельно от портала ему нечего показать."
    />

    <B24Skeleton
      v-else-if="gate === 'checking' || loading"
      class="h-12 w-full"
    />

    <B24Alert
      v-else-if="failure"
      color="air-primary-alert"
      :description="failure"
    />

    <p
      v-else-if="unsaved"
      class="text-sm opacity-70"
    >
      Результат появится здесь, когда клиент пройдёт опрос.
    </p>

    <p
      v-else-if="result?.completed !== true"
      class="text-sm opacity-70"
    >
      {{ WAITING[result?.state ?? ''] ?? WAITING_DEFAULT }}
    </p>

    <template v-else>
      <p
        v-if="editing"
        class="mb-3 text-sm opacity-70"
      >
        Это поле заполняет приложение «Опросы» — править результат вручную нельзя.
      </p>

      <p class="mb-3 font-semibold">
        {{ result.title }}<span
          v-if="result.version"
          class="font-normal opacity-70"
        > · версия {{ result.version }}</span>
      </p>

      <section
        v-for="section in result.sections"
        :key="section.key"
        class="mb-4 last:mb-0"
      >
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="font-semibold">{{ section.title }}</span>
          <B24Badge
            v-if="section.score"
            color="air-primary"
          >
            балл {{ section.score }}
          </B24Badge>
          <!-- Неполнота балла словами, теми же, что в деле ленты сделки: балл по одному
               вопросу из пяти выглядит так же, как по пяти. -->
          <span
            v-if="section.note"
            class="text-sm opacity-70"
          >{{ section.note }}</span>
        </div>

        <!-- ⚠ Ответ выводится только интерполяцией, без `v-html`: это текст постороннего
             человека, и в карточке его читает сотрудник. Правило проекта про чужой текст. -->
        <dl class="flex flex-col gap-2">
          <div
            v-for="answer in section.answers"
            :key="answer.key"
          >
            <dt class="text-sm opacity-70">
              {{ answer.title }}
            </dt>
            <!-- Неразрывный пробел, а не обычный: обычный в начале элемента Vue выбрасывает
                 при сборке шаблона («0из 10» — поймал тест), а «0 из 10» и не должно рваться. -->
            <dd class="whitespace-pre-line break-words">
              {{ answer.value }}<span
                v-if="answer.scale"
                class="opacity-70"
              >&nbsp;{{ answer.scale }}</span>
            </dd>
          </div>
        </dl>
      </section>
    </template>
  </div>
</template>
