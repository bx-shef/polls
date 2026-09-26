<script setup lang="ts">
import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { readFramePass } from '~/utils/frame-auth'
import { isPreview, portalGate } from '~/utils/in-portal'
import { placementItemId } from '~/utils/placement'

/**
 * The survey builder, living inside the «Шаблон опроса» smart-process card.
 *
 * ⚠ ЗАЧЕМ ВКЛАДКА, А НЕ ОТДЕЛЬНЫЙ ЭКРАН ПРИЛОЖЕНИЯ. Анкета — это элемент смарт-процесса
 * на портале клиента: у него есть список, права, история и карточка. Свой экран со своим
 * списком анкет означал бы второй список поверх того, что портал уже показывает, — и первый
 * же вопрос «почему здесь видно, а там нет» упёрся бы в права, которых мы не знаем.
 *
 * ⚠ Сегодня вкладка ПОКАЗЫВАЕТ схему, а не правит её. И даже в таком виде она заменяет
 * текстовое поле «Схема анкеты (JSON)», в котором человек видит простыню в одну строку.
 * Редактор — следующим шагом; разделено потому, что показ уже полезен, а правка требует
 * решений про неизменяемость опубликованной версии.
 */

interface Band {
  from: number
  to: number
  text: string
}

interface Question {
  key: string
  title: string
  type: 'scale' | 'text' | 'date'
  weight: number
  scored: boolean
  scale?: { min: number, max: number }
}

interface Section {
  key: string
  title: string
  scored: boolean
  questions: Question[]
  bands: Band[]
}

/** Претензия к схеме, посчитанная сервером: `app/` в домен не ходит по правилу проекта. */
interface Problem {
  level: 'error' | 'warning'
  where: string
  message: string
}

interface TemplateItem {
  id: number
  code: string
  version: number
  state: string
  schema: { code: string, title: string, sections: Section[] } | null
}

/** Подписи типов вопросов. Вкладку читает сотрудник клиента, а не разработчик. */
const QUESTION_TYPES = {
  scale: 'Балльный',
  text: 'Текстовый',
  date: 'Дата',
} as const satisfies Record<Question['type'], string>

definePageMeta({ layout: 'portal' })

const route = useRoute()

const loading = ref(true)
const resolved = ref(false)
const inPortal = ref(false)
const failure = ref('')
const notProvisioned = ref(false)
const itemId = ref<number | null>(null)
const template = ref<TemplateItem | null>(null)
const problems = ref<Problem[]>([])

/** Что мешает публикации, и что просто стоит знать. Разведены: первое запрещает, второе нет. */
const blocking = computed(() => problems.value.filter(p => p.level === 'error'))
const notes = computed(() => problems.value.filter(p => p.level === 'warning'))

const gate = computed(() => portalGate({
  resolved: resolved.value,
  inPortal: inPortal.value,
  preview: isPreview(route.query.preview),
}))

/** Опубликованная версия неизменяема — это инвариант проекта, и он виден человеку сразу. */
const published = computed(() => template.value?.state === 'published')

/** Сколько вопросов во всей анкете: первое, что спрашивают, открыв чужой шаблон. */
const questionCount = computed(
  () => (template.value?.schema?.sections ?? []).reduce((total, s) => total + s.questions.length, 0),
)

let frame: B24Frame | undefined

useHead({ title: 'Конструктор' })

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

  try {
    itemId.value = placementItemId(frame.placement.options, route.query)
    await loadTemplate()
  }
  catch {
    failure.value = 'Не удалось прочитать анкету с портала. Обновите страницу.'
  }
  finally {
    loading.value = false
  }
})

async function loadTemplate() {
  if (itemId.value === null) return

  const pass = readFramePass(frame!.auth.getAuthData())
  if (pass === null) {
    failure.value = 'Портал не передал данные авторизации. Обновите страницу.'
    return
  }

  const answer = await $fetch<
    { ok: true, template: TemplateItem, problems: Problem[] } | { ok: false, reason: string }
  >('/api/portal/template', {
    method: 'POST',
    body: { memberId: pass.memberId, authId: pass.authId, itemId: itemId.value },
  })

  if (answer.ok) {
    template.value = answer.template
    // ⚠ `?? []` — не перестраховка, а стык версий. Страница и сервер выкатываются одним
    // образом, но окно между ними есть всегда: открытая вкладка живёт в браузере дольше
    // перезапуска контейнера. Ответ без этого поля уронил бы страницу целиком, и снаружи
    // это выглядело бы как «конструктор перестал работать».
    problems.value = answer.problems ?? []
    return
  }
  // «Не настроено» и «нет элемента» различаются текстом: первое лечит администратор,
  // второе означает, что вкладку открыли не из карточки.
  notProvisioned.value = answer.reason === 'not-provisioned'
  if (!notProvisioned.value) itemId.value = null
}
</script>

<template>
  <B24DashboardPanel id="template-tab">
    <template #header>
      <B24DashboardNavbar
        :toggle="false"
        title="Конструктор анкеты"
      />
    </template>

    <template #body>
      <!-- ⚠ ПЕРВЫМ, раньше скелета: снаружи портала нет ни анкеты, ни прав на неё. Тот же
           порядок, что у вкладки сделки и `/install`, и по той же причине — там ветка ниже
           скелета показывала бесконечную загрузку, потому что `stage` оставался `starting`. -->
      <B24Alert
        v-if="gate === 'outside'"
        color="air-secondary-accent"
        title="Откройте вкладку из Битрикс24"
        description="Эта страница живёт внутри портала: она показывает анкету из карточки «Шаблона опроса» и без портала не знает ни анкеты, ни ваших прав на неё."
      />

      <B24Skeleton
        v-else-if="gate === 'checking' || loading"
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
        v-else-if="itemId === null || template === null"
        color="air-primary-warning"
        title="Анкета не определена"
        description="Откройте вкладку из карточки шаблона опроса."
      />

      <div
        v-else
        class="flex flex-col gap-4"
      >
        <B24Card>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-lg font-semibold">{{ template.schema?.title || template.code || 'Без названия' }}</span>
            <B24Badge
              v-if="published"
              color="air-primary-success"
              label="Опубликована"
            />
            <B24Badge
              v-else
              color="air-secondary"
              label="Черновик"
            />
            <B24Badge
              v-if="template.version > 0"
              color="air-secondary"
              :label="`Версия ${template.version}`"
            />
          </div>

          <p class="mt-2 text-sm text-(--ui-color-text-secondary)">
            Код анкеты: {{ template.code || '—' }}. Разделов:
            {{ template.schema?.sections.length ?? 0 }}, вопросов: {{ questionCount }}.
          </p>

          <!-- ⚠ Про неизменяемость сказано ЗДЕСЬ, а не в момент отказа сохранить. Человек,
               открывший опубликованную анкету, должен узнать правило до того, как потратит
               двадцать минут на правки. -->
          <B24Alert
            v-if="published"
            class="mt-3"
            color="air-secondary-accent"
            title="Эта версия уже опубликована"
            description="Опубликованную версию править нельзя: по ней уже собрана статистика, и правка формулировки задним числом сделала бы прошлые ответы несравнимыми. Чтобы изменить анкету, создайте новую версию."
          />
        </B24Card>

        <!-- ⚠ Претензии показываются ВЫШЕ самой анкеты. Их читают, когда собираются
             публиковать, и спрятав их под список разделов мы бы заставили человека сначала
             пролистать то, что он и так знает. -->
        <B24Card v-if="blocking.length > 0">
          <div class="font-semibold">
            Пока нельзя опубликовать
          </div>
          <ul class="mt-2 flex flex-col gap-2">
            <li
              v-for="(problem, index) in blocking"
              :key="`e${index}`"
              class="text-sm"
            >
              <span class="font-medium">{{ problem.where }}.</span>
              <span class="ml-1">{{ problem.message }}</span>
            </li>
          </ul>
        </B24Card>

        <B24Card v-if="notes.length > 0">
          <div class="font-semibold">
            Стоит знать
          </div>
          <ul class="mt-2 flex flex-col gap-2">
            <li
              v-for="(problem, index) in notes"
              :key="`w${index}`"
              class="text-sm text-(--ui-color-text-secondary)"
            >
              <span class="font-medium">{{ problem.where }}.</span>
              <span class="ml-1">{{ problem.message }}</span>
            </li>
          </ul>
        </B24Card>

        <B24Alert
          v-if="template.schema === null"
          color="air-primary-warning"
          title="Схема анкеты пуста"
          description="В этом элементе нет схемы или она записана не как JSON. Так выглядит карточка, созданная на портале вручную."
        />

        <B24Card
          v-for="section in template.schema?.sections ?? []"
          :key="section.key"
        >
          <div class="flex flex-wrap items-center gap-2">
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

          <ul class="mt-3 flex flex-col gap-2">
            <li
              v-for="question in section.questions"
              :key="question.key"
              class="text-sm"
            >
              <span>{{ question.title }}</span>
              <span class="ml-2 text-(--ui-color-text-secondary)">
                {{ QUESTION_TYPES[question.type] }}<template v-if="question.scale">, шкала {{ question.scale.min }}–{{ question.scale.max }}</template><template v-if="!question.scored">, не идёт в оценку</template>
              </span>
            </li>
          </ul>

          <!-- Диапазоны показываются вместе с секцией: это то, что увидит респондент,
               и единственное место, где видно, покрывают ли они шкалу без дыр. -->
          <ul
            v-if="section.bands.length > 0"
            class="mt-3 flex flex-col gap-1 border-t border-(--ui-color-design-outline-stroke) pt-3"
          >
            <li
              v-for="band in section.bands"
              :key="`${band.from}-${band.to}`"
              class="text-sm text-(--ui-color-text-secondary)"
            >
              {{ band.from }}–{{ band.to }}: {{ band.text }}
            </li>
          </ul>
        </B24Card>
      </div>
    </template>
  </B24DashboardPanel>
</template>
