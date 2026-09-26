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
 * ⚠ ЧЕРНОВИК ПРАВИТСЯ, ОПУБЛИКОВАННАЯ ВЕРСИЯ ТОЛЬКО ПОКАЗЫВАЕТСЯ. Это инвариант проекта,
 * и вкладка говорит о нём ДО правок, а не в момент отказа сохранить: человек, открывший
 * опубликованную анкету, должен узнать правило раньше, чем потратит двадцать минут.
 * Запрет при этом держится НЕ интерфейсом — сервер перечитывает состояние с портала
 * и отказывает сам, потому что вкладка могла быть открыта час назад.
 *
 * ⚠ КЛЮЧИ ВОПРОСОВ ЗДЕСЬ НЕ ВЫДАЮТСЯ. Новый вопрос уезжает с пустым ключом, и ключ ему даёт
 * сервер: генератор живёт в домене, а `app/` в серверные модули не ходит по правилу проекта.
 * Своя копия генератора в браузере была бы вторым словарём на одну вещь — и разошлась бы
 * с первым ровно тогда, когда правят одну из двух.
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
  /** Отметка изменения с портала: уезжает обратно, чтобы поймать правку из соседней вкладки. */
  updatedAt?: string
  schema: { code: string, title: string, sections: Section[] } | null
}

/** Подписи типов вопросов. Вкладку читает сотрудник клиента, а не разработчик. */
const QUESTION_TYPES = {
  scale: 'Балльный',
  text: 'Текстовый',
  date: 'Дата',
} as const satisfies Record<Question['type'], string>

/** Отказы сохранения: у каждого свой текст, потому что чинятся они по-разному. */
const SAVE_REFUSALS: Record<string, string> = {
  'published': 'Эту версию уже опубликовали, пока вкладка была открыта. Править её нельзя — создайте новую версию.',
  'not-object': 'Анкета не сохранилась: сервер не разобрал присланное. Обновите страницу.',
  'too-big': 'Анкета слишком большая. Сократите тексты вопросов или разбейте её на две.',
  'too-many': 'Слишком много разделов или вопросов. Разбейте анкету на две.',
  'no-item': 'Анкета не найдена. Возможно, карточку удалили, пока вкладка была открыта.',
  'denied': 'У вас нет доступа к этой анкете — править её нельзя.',
  'stale': 'Анкету изменили в другом месте, пока вы правили эту. Обновите страницу, чтобы не затереть чужую работу.',
  'not-saved': 'Портал не подтвердил запись. Анкета НЕ сохранена — попробуйте ещё раз.',
  'invalid': 'Анкету нельзя опубликовать, пока в ней есть то, что мешает. Список выше.',
  'no-schema': 'В анкете нет схемы — сначала соберите её и сохраните.',
  'not-published': 'Новую версию заводят от опубликованной. Эта ещё черновик.',
  'no-action': 'Вкладка не сказала порталу, что именно сделать. Обновите страницу.',
  'not-provisioned': 'Приложение ещё настраивается: смарт-процессы опросов на портале не найдены.',
}

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
const saving = ref(false)
const saved = ref(false)

/**
 * Отказ СОХРАНЕНИЯ — отдельно от отказа загрузки.
 *
 * ⚠ Общий `failure` стоит в ветке `v-else-if` выше редактора и подменяет его собой целиком.
 * То есть неудачное сохранение вытирало с экрана форму вместе со всеми правками, и совет
 * «сократите тексты вопросов» выполнить было уже нечем — оставалось перезагрузить страницу
 * и потерять работу. Нашёл `/code-review`.
 */
const saveFailure = ref('')

/** Идёт ли публикация или заведение новой версии. Кнопки на это время гаснут. */
const releasing = ref(false)
/** Что сказать после удачного действия: «опубликовано» или «версия заведена». */
const releaseNote = ref('')

/**
 * Черновик под правкой — СВОЯ копия, а не тот же объект.
 *
 * ⚠ Правка напрямую по ответу сервера означала бы, что отменить её нечем: исходного
 * состояния уже нет. Копия даёт «отменить» бесплатно — достаточно перечитать.
 */
const draft = ref<{ code: string, title: string, sections: Section[] } | null>(null)

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

/** Что показываем: правимый черновик или сохранённое. Второе — у опубликованной версии. */
const shown = computed(() => draft.value ?? template.value?.schema ?? null)

/** Сколько вопросов во всей анкете: первое, что спрашивают, открыв чужой шаблон. */
const questionCount = computed(
  () => (shown.value?.sections ?? []).reduce((total, s) => total + s.questions.length, 0),
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

/** Начать правку: копия схемы либо пустая анкета, если схемы ещё нет. */
function edit(): void {
  const schema = template.value?.schema
  // ⚠ Название пустое, а НЕ равно коду. `pnpm publish:templates` считает элемент, у которого
  // имя совпадает с кодом, безымянным и отказывается его публиковать — то есть подставленный
  // код тихо создавал анкету, которую нельзя выпустить. Пустое поле честно попросит название,
  // и о нём же скажет проверка. Нашёл `/code-review`.
  draft.value = schema === null || schema === undefined
    ? { code: template.value?.code ?? '', title: '', sections: [] }
    : JSON.parse(JSON.stringify(schema)) as typeof draft.value
  saved.value = false
  saveFailure.value = ''
}

/** Отменить: просто выбросить копию. Сохранённое никуда не девалось. */
function cancel(): void {
  draft.value = null
  saved.value = false
  saveFailure.value = ''
}

function addSection(): void {
  // Ключ пустой намеренно: его выдаст сервер. Разбор — в шапке файла.
  draft.value?.sections.push({ key: '', title: 'Новый раздел', scored: false, questions: [], bands: [] })
}

function removeSection(index: number): void {
  draft.value?.sections.splice(index, 1)
}

function addQuestion(section: Section): void {
  section.questions.push({ key: '', title: '', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } })
}

function removeQuestion(section: Section, index: number): void {
  section.questions.splice(index, 1)
}

function addBand(section: Section): void {
  section.bands.push({ from: 0, to: 0, text: '' })
}

function removeBand(section: Section, index: number): void {
  section.bands.splice(index, 1)
}

/**
 * Включить или выключить балльность вопроса.
 *
 * ⚠ Шкала появляется и исчезает вместе с типом, а не живёт сама по себе: у небалльного
 * вопроса она ничего не значит, и оставшись в схеме выглядела бы настройкой, которая
 * почему-то не работает. Сервер её всё равно не примет — здесь то же правило, чтобы человек
 * видел согласованную форму, а не узнавал о расхождении после сохранения.
 */
function onTypeChange(question: Question): void {
  if (question.type === 'scale') {
    question.scale ??= { min: 0, max: 10 }
    return
  }
  delete question.scale
  question.scored = false
}

/**
 * Шкала вопроса для правки — создаётся, если её нет.
 *
 * ⚠ Поля шкалы висели на `question.scale`, а сервер выбрасывает шкалу, у которой хоть одна
 * граница пуста. Очистив `min`, автор получал балльный вопрос БЕЗ полей шкалы: починить его
 * во вкладке стало нечем, а публикацию он блокировал навсегда. Нашёл `/code-review`.
 * Теперь поля есть всегда, пока вопрос балльный, — а «шкала не задана» скажет проверка.
 */
function scaleOf(question: Question): { min: number, max: number } {
  question.scale ??= { min: 0, max: 10 }
  return question.scale
}

/**
 * Опубликовать черновик или завести новую версию от опубликованной.
 *
 * ⚠ Одно действие на два роута не делится: они взаимно исключают друг друга по инварианту,
 * и решает состояние, а не кнопка. Проверку состояния сервер делает сам — вкладка лишь
 * показывает ту кнопку, которая сейчас осмысленна.
 */
async function release(action: 'publish' | 'new-version'): Promise<void> {
  if (itemId.value === null || frame === undefined) return

  const pass = readFramePass(frame.auth.getAuthData())
  if (pass === null) {
    saveFailure.value = 'Портал не передал данные авторизации. Обновите страницу.'
    return
  }

  releasing.value = true
  saveFailure.value = ''
  releaseNote.value = ''

  /**
   * Удалась ли публикация.
   *
   * ⚠ Перечитка состояния идёт ПОСЛЕ этого `try`, а не внутри него: её отказ внутри показывал
   * бы «связь прервалась» на удавшейся публикации — то есть человек считал бы, что анкета
   * НЕ вышла, хотя она уже вышла. Нашёл `/code-review`.
   */
  let releasedVersion = 0

  try {
    const answer = await $fetch<
      | { ok: true, action: string, version?: number, itemId?: number, entityTypeId?: number, reused?: boolean }
      | { ok: false, reason: string, problems?: Problem[] }
    >('/api/portal/template-publish', {
      method: 'POST',
      body: { memberId: pass.memberId, authId: pass.authId, itemId: itemId.value, action },
    })

    if (!answer.ok) {
      saveFailure.value = SAVE_REFUSALS[answer.reason] ?? 'Не получилось. Попробуйте ещё раз.'
      // ⚠ Претензии от сервера ЗАБИРАЕМ. Отказ говорит «список выше», а список на экране —
      // это то, что вкладка прочитала при открытии; схему на портале могли поправить
      // с тех пор, и человек получил бы совет чинить то, чего не видит.
      if (answer.problems !== undefined) problems.value = answer.problems
    }
    else if (answer.action === 'publish') {
      releasedVersion = answer.version ?? 0
    }
    else {
      releaseNote.value = answer.reused === true
        ? 'Черновик новой версии уже был заведён раньше — открываю его.'
        : 'Новая версия заведена черновиком — правьте её в открывшейся карточке.'
      await openCard(answer.itemId ?? 0, answer.entityTypeId ?? 0)
    }
  }
  catch {
    saveFailure.value = 'Связь с порталом прервалась. Проверьте и попробуйте ещё раз.'
  }
  finally {
    releasing.value = false
  }

  if (releasedVersion === 0) return

  releaseNote.value = `Анкета опубликована как версия ${releasedVersion}.`
  try {
    await loadTemplate()
  }
  catch {
    releaseNote.value += ' Обновите страницу, чтобы увидеть новое состояние.'
  }
}

/**
 * Открыть карточку новой версии слайдером портала.
 *
 * ⚠ Новая версия — ДРУГОЙ элемент, а вкладка привязана к текущему: сама она туда перейти
 * не может. Слайдер кладётся поверх и закрывается крестиком портала, так что работа остаётся
 * на месте. Отказ слайдера молчаливым не оставляем: без карточки человек не найдёт версию,
 * которую только что завёл.
 */
async function openCard(newItemId: number, typeId: number): Promise<void> {
  // ⚠ `entityTypeId` приходит ОТ СЕРВЕРА. Вкладка его не знает: портал кладёт во фрейм только
  // идентификатор элемента, а тип объекта отдельным ключом не приходит вовсе — так написано
  // в документации точки встраивания. Прежняя редакция читала его из строки запроса, которой
  // у обработчика нет, и всегда получала ноль: адрес выходил `/crm/type//details/N/`,
  // слайдер открывал сломанную страницу, а запасной текст не срабатывал — `openPath`
  // на это не ругается. Нашёл `/code-review`.
  if (newItemId <= 0 || typeId <= 0) {
    releaseNote.value = `${releaseNote.value} Карточка №${newItemId} — откройте её в списке шаблонов.`
    return
  }
  try {
    // ⚠ `openPath` принимает URL, а не строку: путь сначала собирается `getUrl` — он знает
    // адрес портала, а мы его знать не обязаны. Приём взят у соседнего приложения, где он
    // работает в бою.
    const path = frame!.slider.getUrl(`/crm/type/${typeId}/details/${newItemId}/`)
    await frame!.slider.openPath(path, 1100)
  }
  catch {
    releaseNote.value = `Новая версия заведена черновиком — карточка №${newItemId}. Откройте её в списке шаблонов.`
  }
}

async function save(): Promise<void> {
  if (draft.value === null || itemId.value === null || frame === undefined) return

  const pass = readFramePass(frame.auth.getAuthData())
  if (pass === null) {
    failure.value = 'Портал не передал данные авторизации. Обновите страницу.'
    return
  }

  saving.value = true
  saveFailure.value = ''
  try {
    const answer = await $fetch<
      { ok: true, template: TemplateItem, problems: Problem[] } | { ok: false, reason: string }
    >('/api/portal/template-save', {
      method: 'POST',
      body: {
        memberId: pass.memberId,
        authId: pass.authId,
        itemId: itemId.value,
        schema: draft.value,
        updatedAt: template.value?.updatedAt ?? '',
      },
    })

    if (!answer.ok) {
      saveFailure.value = SAVE_REFUSALS[answer.reason] ?? 'Сохранить не получилось. Попробуйте ещё раз.'
      return
    }

    template.value = answer.template
    problems.value = answer.problems ?? []
    // ⚠ Копия выбрасывается: дальше правят то, что РЕАЛЬНО сохранилось. Сервер раздал ключи
    // новым вопросам и мог подставить код анкеты, и продолжать править прежнюю копию значило бы
    // отправить эти ключи обратно пустыми — то есть выдать им новые при следующем сохранении.
    draft.value = null
    saved.value = true
  }
  catch {
    saveFailure.value = 'Не удалось сохранить анкету. Проверьте связь и попробуйте ещё раз.'
  }
  finally {
    saving.value = false
  }
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
            <B24Input
              v-if="draft"
              v-model="draft.title"
              class="min-w-[220px] grow"
              placeholder="Название анкеты — его видит отвечающий"
            />
            <span
              v-else
              class="text-lg font-semibold"
            >{{ shown?.title || template.code || 'Без названия' }}</span>
            <!-- ⚠ Код спрашиваем, только пока его нет. Он внешний ключ: по нему живут
                 выпущенные ссылки и вся статистика версий, и менять его у существующей
                 анкеты значит оторвать новую версию от собственной истории. Поэтому
                 у заполненного он показан текстом и правке не подлежит. -->
            <B24Input
              v-if="draft && !template.code"
              v-model="draft.code"
              class="w-48"
              placeholder="код: латиницей"
            />
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
            {{ shown?.sections.length ?? 0 }}, вопросов: {{ questionCount }}.
          </p>

          <!-- ⚠ Кнопок правки у опубликованной версии нет вовсе, а не «есть, но отказывают»:
               предлагать действие, которое заведомо не сработает, — это способ потратить
               чужое время. Настоящий запрет при этом на сервере, здесь только честный вид. -->
          <div
            v-if="!published"
            class="mt-3 flex flex-wrap items-center gap-2"
          >
            <B24Button
              v-if="!draft"
              color="air-primary"
              label="Править"
              @click="edit"
            />
            <template v-else>
              <B24Button
                color="air-primary-success"
                :label="saving ? 'Сохраняю…' : 'Сохранить'"
                :disabled="saving"
                @click="save"
              />
              <B24Button
                color="air-secondary"
                label="Отменить"
                :disabled="saving"
                @click="cancel"
              />
            </template>
            <span
              v-if="saved"
              class="text-sm text-(--ui-color-text-secondary)"
            >Сохранено.</span>

            <!-- ⚠ Публикация видна, только пока нет правок под рукой: публиковать то, что
                 не сохранено, нельзя — сервер берёт схему с портала, а не из формы, и человек
                 опубликовал бы прошлую редакцию, считая, что выпустил свою. -->
            <B24Button
              v-if="!draft"
              color="air-primary-success"
              :label="releasing ? 'Публикую…' : 'Опубликовать'"
              :disabled="releasing || blocking.length > 0"
              @click="release('publish')"
            />
            <span
              v-if="!draft && blocking.length > 0"
              class="text-sm text-(--ui-color-text-secondary)"
            >Сначала исправьте то, что мешает.</span>
          </div>

          <!-- ⚠ У опубликованной версии действие ровно одно, и это и есть разрешённая форма
               её правки: новая версия. Инвариант — опубликованная неизменяема, по ней уже
               собрана статистика, а ссылки у людей ведут именно на неё. -->
          <div
            v-else
            class="mt-3 flex flex-wrap items-center gap-2"
          >
            <B24Button
              color="air-primary"
              :label="releasing ? 'Завожу…' : 'Создать новую версию'"
              :disabled="releasing"
              @click="release('new-version')"
            />
          </div>

          <p
            v-if="releaseNote"
            class="mt-2 text-sm text-(--ui-color-text-secondary)"
          >
            {{ releaseNote }}
          </p>

          <!-- ⚠ Отказ сохранения живёт ЗДЕСЬ, рядом с кнопками, а не в общей ветке отказа
               выше: та подменяет собой весь редактор, и правки исчезали бы вместе с ним. -->
          <B24Alert
            v-if="saveFailure"
            class="mt-3"
            color="air-primary-alert"
            title="Не сохранилось"
            :description="saveFailure"
          />

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
          v-if="shown === null"
          color="air-primary-warning"
          title="Схема анкеты пуста"
          description="В этом элементе нет схемы или она записана не как JSON. Так выглядит карточка, созданная на портале вручную — нажмите «Править», чтобы собрать анкету."
        />

        <!-- ⚠ Ключ строки — ИНДЕКС, а не ключ раздела, и только в режиме правки. У только что
             добавленного раздела ключа ещё нет (его выдаст сервер), и два новых подряд имели бы
             одинаковый пустой ключ — Vue переиспользовал бы узлы, и текст из одного поля
             появлялся бы в другом. В режиме показа ключи уже настоящие. -->
        <B24Card
          v-for="(section, sectionIndex) in shown?.sections ?? []"
          :key="draft ? `draft-${sectionIndex}` : section.key"
        >
          <div class="flex flex-wrap items-center gap-2">
            <template v-if="draft">
              <B24Input
                v-model="section.title"
                class="min-w-[200px] grow"
                placeholder="Название раздела"
              />
              <B24Checkbox
                v-model="section.scored"
                label="С баллом"
              />
              <B24Button
                color="air-secondary-alert"
                label="Удалить раздел"
                @click="removeSection(sectionIndex)"
              />
            </template>
            <template v-else>
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
            </template>
          </div>

          <ul class="mt-3 flex flex-col gap-2">
            <li
              v-for="(question, questionIndex) in section.questions"
              :key="draft ? `dq-${questionIndex}` : question.key"
              class="text-sm"
            >
              <div
                v-if="draft"
                class="flex flex-wrap items-center gap-2"
              >
                <B24Input
                  v-model="question.title"
                  class="min-w-[220px] grow"
                  placeholder="Формулировка вопроса"
                />
                <select
                  v-model="question.type"
                  class="rounded border border-(--ui-color-design-outline-stroke) px-2 py-1 text-sm"
                  @change="onTypeChange(question)"
                >
                  <option
                    v-for="(label, value) in QUESTION_TYPES"
                    :key="value"
                    :value="value"
                  >
                    {{ label }}
                  </option>
                </select>
                <template v-if="question.type === 'scale'">
                  <B24Input
                    v-model.number="scaleOf(question).min"
                    class="w-20"
                    type="number"
                  />
                  <B24Input
                    v-model.number="scaleOf(question).max"
                    class="w-20"
                    type="number"
                  />
                  <B24Checkbox
                    v-model="question.scored"
                    label="В оценку"
                  />
                  <B24Input
                    v-if="question.scored"
                    v-model.number="question.weight"
                    class="w-20"
                    type="number"
                  />
                </template>
                <B24Button
                  color="air-secondary-alert"
                  label="Убрать"
                  @click="removeQuestion(section, questionIndex)"
                />
              </div>
              <template v-else>
                <span>{{ question.title }}</span>
                <span class="ml-2 text-(--ui-color-text-secondary)">
                  {{ QUESTION_TYPES[question.type] }}<template v-if="question.scale">, шкала {{ question.scale.min }}–{{ question.scale.max }}</template><template v-if="!question.scored">, не идёт в оценку</template>
                </span>
              </template>
            </li>
          </ul>

          <B24Button
            v-if="draft"
            class="mt-2"
            color="air-tertiary"
            label="Добавить вопрос"
            @click="addQuestion(section)"
          />

          <!-- Диапазоны показываются вместе с разделом: это то, что увидит респондент,
               и единственное место, где видно, покрывают ли они шкалу без дыр. -->
          <ul
            v-if="section.bands.length > 0 || draft"
            class="mt-3 flex flex-col gap-1 border-t border-(--ui-color-design-outline-stroke) pt-3"
          >
            <li
              v-for="(band, bandIndex) in section.bands"
              :key="draft ? `db-${bandIndex}` : `${band.from}-${band.to}`"
              class="text-sm text-(--ui-color-text-secondary)"
            >
              <div
                v-if="draft"
                class="flex flex-wrap items-center gap-2"
              >
                <B24Input
                  v-model.number="band.from"
                  class="w-20"
                  type="number"
                />
                <B24Input
                  v-model.number="band.to"
                  class="w-20"
                  type="number"
                />
                <B24Input
                  v-model="band.text"
                  class="min-w-[220px] grow"
                  placeholder="Что увидит отвечающий с такой оценкой"
                />
                <B24Button
                  color="air-secondary-alert"
                  label="Убрать"
                  @click="removeBand(section, bandIndex)"
                />
              </div>
              <template v-else>
                {{ band.from }}–{{ band.to }}: {{ band.text }}
              </template>
            </li>
          </ul>

          <B24Button
            v-if="draft"
            class="mt-2"
            color="air-tertiary"
            label="Добавить диапазон"
            @click="addBand(section)"
          />
        </B24Card>

        <B24Button
          v-if="draft"
          color="air-secondary"
          label="Добавить раздел"
          @click="addSection"
        />
      </div>
    </template>
  </B24DashboardPanel>
</template>
