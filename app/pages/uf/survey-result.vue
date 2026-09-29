<script setup lang="ts">
import { DEAL_TAB_TITLE, SURVEY_SP_TITLE } from '#shared/portal-names'
import { useFieldWidget } from '~/composables/useFieldWidget'

/**
 * The survey-result field in the survey card (`SURVEY_SP_TITLE`): the survey result, in words.
 *
 * ⚠ ЭТО ПОЛЕ НАШЕГО ТИПА, а не вкладка. Портал открывает страницу во фрейме прямо внутри
 * карточки, на месте значения поля, — вместо двух JSON-полей, которые человек прочитать
 * не мог. Данные лежат в тех же JSON-полях элемента; страница их только показывает.
 *
 * ⚠ ТОЛЬКО ПОКАЗЫВАЕТ. Значение полю своего типа задаёт единственный вызов — `setValue`
 * из его же фрейма, — и его нет ни здесь, ни в общем каркасе (`useFieldWidget`). Поэтому поле
 * нередактируемо по построению, в том числе в режиме правки карточки. Сверх того с ревизии 4
 * поле закрыто и флагом `editInList: 'N'`, как все наши поля (`server/domain/portals/userfield-type.ts`).
 *
 * ⚠ ВЫСОТУ ПОЛЯ СТРАНИЦА ЗАДАЁТ САМА (`useFieldWidget`). Регистрация типа знает только начальную
 * высоту, а число вопросов у анкет разное: одна константа дала бы либо обрезанный результат,
 * либо пустое место.
 *
 * С ревизии 6 поле стоит в карточке ВМЕСТО JSON-полей — второй шаг #81, после того как владелец
 * 28.09 живьём увидел, что пустое поле своего типа портал рисует. Разбор — `docs/PROCESS.md`, раздел 9.
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
  /** «ответ на 1 из 5, пропуск — низшая оценка» или «без оценки…»; пусто — пояснять нечего. */
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
  'foreign-card': `Это поле показывает результат опроса и работает только в карточке «${SURVEY_SP_TITLE}». Здесь его можно удалить из карточки.`,
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
  delivering: 'Клиент ответил — результат появится здесь, как только запишется в портал.',
  expired: `Срок ссылки истёк, клиент не ответил. Чтобы спросить ещё раз, выпустите новую ссылку во вкладке «${DEAL_TAB_TITLE}» сделки.`,
  revoked: 'Ссылку отозвали или она так и не заработала — ответа по ней не будет.',
}
const WAITING_DEFAULT = 'Клиент ещё не прошёл опрос. Результат появится здесь сразу после ответа.'

definePageMeta({ layout: 'portal' })

useHead({ title: 'Результат опроса' })

// Каркас фрейма — общий с полем «Анкета» (`useFieldWidget`): высота, ширина, контекст портала, отказы.
const { gate, loading, failure, editing, unsaved, reply: result, root } = useFieldWidget<SurveyResultReply>({
  endpoint: '/api/portal/survey-result',
  refusals: REFUSALS,
  texts: {
    noItem: 'Портал не сообщил, какой опрос открыт. Обновите карточку.',
    refused: 'Не удалось показать результат опроса. Обновите карточку.',
    unreachable: 'Не удалось получить результат опроса с портала. Обновите карточку.',
  },
})
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
      :description="`Это поле показывает результат опроса внутри карточки «${SURVEY_SP_TITLE}» на портале. Отдельно от портала ему нечего показать.`"
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
          <!-- Неполнота балла словами, теми же, что в деле ленты сделки: пропуск входит в балл
               низшей оценкой, и без подписи «недоволен» не отличить от «не ответил». -->
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
