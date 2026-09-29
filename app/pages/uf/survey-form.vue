<script setup lang="ts">
import { TEMPLATE_SP_TITLE, TEMPLATE_TAB_TITLE } from '#shared/portal-names'
import { useFieldWidget } from '~/composables/useFieldWidget'
import { DATE_HINT, QUESTION_TYPES, type QuestionType } from '~/utils/question-labels'

/**
 * The «Анкета» field in the template card (`TEMPLATE_SP_TITLE`): the survey itself, in words (#84, п. 18).
 *
 * ⚠ ЭТО ПОЛЕ НАШЕГО ТИПА, как «Результат опроса» в карточке «Результата опросов», и каркас фрейма
 * у них общий (`useFieldWidget`, там же — всё про высоту, ширину и `setValue`). Портал открывает
 * страницу на месте значения поля — вместо схемы-JSON, которую человек прочитать не мог.
 *
 * ⚠ ТОЛЬКО ПОКАЗЫВАЕТ. Править анкету — во вкладке конструктора: там проверки, черновик и публикация.
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

interface FormView {
  code: string
  /** Ноль — версии ещё нет: черновик, которого никто не публиковал. */
  version: number
  /** `draft` | `published` | `retired` | пусто — не разобрали (`templateStateOf` на сервере). */
  state: string
  title: string
  sections: FormSection[]
}

interface SurveyFormReply {
  ok: boolean
  reason?: string
  form?: FormView
}

/** Отказы сервера — каждый своим текстом: чинятся они по-разному. */
const REFUSALS: Record<string, string> = {
  // Портал не различает «не видит» и «удалили» — отказ один, и слова честно называют оба случая.
  'denied': 'У вас нет доступа к этой анкете — или её удалили.',
  'not-provisioned': 'Приложение ещё настраивается: смарт-процессы опросов на портале не найдены.',
  'foreign-card': `Это поле показывает анкету и работает только в карточке «${TEMPLATE_SP_TITLE}». Здесь его можно удалить из карточки.`,
  // ⚠ Отдельно от `foreign-card`: это сбой встраивания на НАСТОЯЩЕЙ карточке, и совет
  // «удалите поле» здесь увёл бы администратора снимать исправный виджет.
  'no-owner': 'Портал не сообщил, в какой карточке открыто поле. Обновите карточку.',
  'no-item': 'Анкета не найдена. Возможно, карточку удалили.',
}

/**
 * Версия и состояние — одной строкой в шапке поля.
 *
 * ⚠ Состояние — наше, по закрытым полям (`templateStateOf`), а не стадия: стадию двигают в канбане.
 * Без него снятая с публикации версия читалась бы как действующая. Нашли программист, `/review`
 * и `/code-review` в панели PR #100: состояние приходило с сервера, а страница его не показывала.
 */
function versionNote(form: FormView): string {
  if (form.state === 'retired') return `версия ${form.version} · снята с публикации`
  if (form.state === 'draft') return form.version > 0 ? `черновик версии ${form.version}` : 'черновик, версии ещё нет'
  return form.version > 0 ? `версия ${form.version}` : 'черновик, версии ещё нет'
}

definePageMeta({ layout: 'portal' })

useHead({ title: 'Анкета' })

// Каркас фрейма — общий с «Результатом опроса» (`useFieldWidget`): высота, ширина, контекст портала, отказы.
const { gate, loading, failure, editing, unsaved, reply, root } = useFieldWidget<SurveyFormReply>({
  endpoint: '/api/portal/survey-form',
  refusals: REFUSALS,
  texts: {
    noItem: 'Портал не сообщил, какая анкета открыта. Обновите карточку.',
    refused: 'Не удалось показать анкету. Обновите карточку.',
    unreachable: 'Не удалось получить анкету с портала. Обновите карточку.',
  },
})

const form = computed(() => reply.value?.form ?? null)
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
        {{ form.title || form.code }}<span class="font-normal opacity-70"> · {{ versionNote(form) }}</span>
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
          <!-- Ключ — с номером строки: у черновика бывают одинаковые диапазоны (проверка идёт при
               публикации), и ключ из одних границ повторился бы. Список здесь рисуется один раз,
               но повторённый ключ — ошибка вёрстки, которая выстрелит при первой перерисовке. -->
          <li
            v-for="(band, bandIndex) in section.bands"
            :key="`${bandIndex}-${band.from}-${band.to}`"
            class="text-sm opacity-70"
          >
            {{ band.from }}–{{ band.to }}: {{ band.text }}
          </li>
        </ul>
      </section>
    </template>

    <!-- Ответ без анкеты — расхождение с роутом, а не пустое поле: молча показать пустоту значило бы
         оставить человека гадать (`/review` и `/code-review` в замыкающем круге панели PR #100). -->
    <B24Alert
      v-else
      color="air-primary-alert"
      description="Не удалось показать анкету. Обновите карточку."
    />
  </div>
</template>
