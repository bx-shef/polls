<script setup lang="ts">
import { MessageCommands, initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { TEMPLATE_SP_TITLE, TEMPLATE_TAB_TITLE } from '#shared/portal-names'
import { framePass } from '~/utils/frame-auth'
import { isPreview, portalGate } from '~/utils/in-portal'
import { fieldContext } from '~/utils/placement'
import { DATE_HINT, QUESTION_TYPES, type QuestionType } from '~/utils/question-labels'

/**
 * The «Анкета» field in the template card (`TEMPLATE_SP_TITLE`): the survey itself, in words (#84, п. 18).
 *
 * ⚠ ЭТО ПОЛЕ НАШЕГО ТИПА, как «Результат опроса» в карточке «Результата опросов» (`survey-result.vue`,
 * там же — всё про фрейм, высоту и `setValue`). Портал открывает страницу на месте значения поля —
 * вместо схемы-JSON, которую человек прочитать не мог. Данные лежат в той же схеме элемента.
 *
 * ⚠ ТОЛЬКО ПОКАЗЫВАЕТ. Править анкету — во вкладке конструктора: там проверки, черновик и публикация.
 * Значение полю задаёт единственный вызов, `setValue` из его же фрейма, и здесь его нет.
 */

interface FormQuestion {
  key: string
  title: string
  type: QuestionType
  scored: boolean
  scale: { min: number, max: number } | null
}

interface FormSection {
  key: string
  title: string
  scored: boolean
  questions: FormQuestion[]
  bands: { from: number, to: number, text: string }[]
}

interface SurveyFormReply {
  ok: boolean
  reason?: string
  form?: {
    code: string
    /** Ноль — версии ещё нет: черновик, которого никто не публиковал. */
    version: number
    state: string
    title: string
    sections: FormSection[]
  }
}

/** Отказы сервера — каждый своим текстом: чинятся они по-разному. */
const REFUSALS: Record<string, string> = {
  'not-provisioned': 'Приложение ещё настраивается: смарт-процессы опросов на портале не найдены.',
  'foreign-card': `Это поле показывает анкету и работает только в карточке «${TEMPLATE_SP_TITLE}». Здесь его можно удалить из карточки.`,
  // ⚠ Отдельно от `foreign-card`: это сбой встраивания на НАСТОЯЩЕЙ карточке, и совет
  // «удалите поле» здесь увёл бы администратора снимать исправный виджет.
  'no-owner': 'Портал не сообщил, в какой карточке открыто поле. Обновите карточку.',
  'no-item': 'Анкета не найдена. Возможно, карточку удалили.',
}

/** Ниже этого поле не сжимается, пикселей: по той же причине, что у «Результата опроса». */
const MIN_HEIGHT = 60

definePageMeta({ layout: 'portal' })

const route = useRoute()

const resolved = ref(false)
const inPortal = ref(false)
const loading = ref(true)
const failure = ref('')
const editing = ref(false)
const unsaved = ref(false)
const form = ref<SurveyFormReply['form'] | null>(null)

/** Корень содержимого — по нему меряется высота, см. `fit`. */
const root = ref<HTMLElement | null>(null)

const gate = computed(() => portalGate({
  resolved: resolved.value,
  inPortal: inPortal.value,
  preview: isPreview(route.query.preview),
}))

/** Связь с порталом. `undefined` — не внутри портала либо ещё не установлена. */
let frame: B24Frame | undefined

useHead({ title: 'Анкета' })

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
      // Новая карточка бывает только в режиме правки: элемента ещё нет, и это не ошибка.
      if (context.editing) unsaved.value = true
      else failure.value = 'Портал не сообщил, какая анкета открыта. Обновите карточку.'
      return
    }

    const pass = await framePass(frame.auth)
    if (pass === null) throw new Error('нет данных авторизации фрейма')

    const reply = await $fetch<SurveyFormReply>('/api/portal/survey-form', {
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
    if (!reply.ok || reply.form === undefined) {
      failure.value = REFUSALS[reply.reason ?? ''] ?? 'Не удалось показать анкету. Обновите карточку.'
      return
    }
    form.value = reply.form
  }
  catch {
    failure.value = 'Не удалось получить анкету с портала. Обновите карточку.'
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
 * Подогнать высоту поля под содержимое — своим корнем и шириной `'100%'`.
 *
 * Почему именно так, разобрано у `fit` в `survey-result.vue`: документ во фрейме не ниже самого фрейма,
 * а ширина числом прибила бы поле к ширине первого показа.
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
  }
}

/** Подгонять высоту и дальше: при смене ширины карточки длинные формулировки переносятся иначе. */
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
      :description="`Это поле показывает анкету внутри карточки «${TEMPLATE_SP_TITLE}» на портале. Отдельно от портала ему нечего показать.`"
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
      Анкета появится здесь, когда вы её соберёте во вкладке «{{ TEMPLATE_TAB_TITLE }}».
    </p>

    <template v-else-if="form">
      <p
        v-if="editing"
        class="mb-3 text-sm opacity-70"
      >
        Это поле показывает анкету. Править её — во вкладке «{{ TEMPLATE_TAB_TITLE }}».
      </p>

      <p class="mb-3 font-semibold">
        {{ form.title || form.code }}<span class="font-normal opacity-70"> · {{ form.version > 0 ? `версия ${form.version}` : 'черновик, версии ещё нет' }}</span>
      </p>

      <p
        v-if="form.sections.length === 0"
        class="text-sm opacity-70"
      >
        Анкета пока пустая. Соберите её во вкладке «{{ TEMPLATE_TAB_TITLE }}».
      </p>

      <!-- ⚠ Текст анкеты выводится только интерполяцией, без `v-html`: его набрал сотрудник
           на портале. Правило проекта про текст, введённый на портале. -->
      <section
        v-for="section in form.sections"
        :key="section.key"
        class="mb-4 last:mb-0"
      >
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="font-semibold">{{ section.title }}</span>
          <B24Badge
            v-if="section.scored"
            color="air-primary"
            label="С баллом"
          />
          <B24Badge
            v-else
            color="air-secondary"
            label="Без балла"
          />
        </div>

        <ul class="flex flex-col gap-1">
          <li
            v-for="question in section.questions"
            :key="question.key"
            class="text-sm"
          >
            <span class="whitespace-pre-line break-words">{{ question.title }}</span>
            <span class="ml-2 opacity-70">
              {{ QUESTION_TYPES[question.type] ?? question.type }}<template v-if="question.type === 'date'">, {{ DATE_HINT }}</template><template v-if="question.scale">, шкала {{ question.scale.min }}–{{ question.scale.max }}</template><template v-if="!question.scored">, не идёт в оценку</template>
            </span>
          </li>
        </ul>

        <!-- Диапазоны — то, что увидит клиент после ответа: по ним видно, покрывают ли они шкалу. -->
        <ul
          v-if="section.bands.length > 0"
          class="mt-2 flex flex-col gap-1 border-t border-(--ui-color-design-outline-stroke) pt-2"
        >
          <li
            v-for="band in section.bands"
            :key="`${band.from}-${band.to}`"
            class="text-sm opacity-70"
          >
            {{ band.from }}–{{ band.to }}: {{ band.text }}
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
