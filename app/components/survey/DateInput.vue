<script setup lang="ts">
import type { InputDateProps } from '@bitrix24/b24ui-nuxt'
import { localeContextInjectionKey } from '@bitrix24/b24ui-nuxt/composables/useLocale'
import { ru } from '@bitrix24/b24ui-nuxt/locale'
import { ANSWER_YEARS, isCalendarDate, isoDay } from '#shared/answer-date'

/**
 * The date question widget of the public survey page: a date field with a calendar.
 *
 * ⚠ ЭТО ЧАСТЬ ПУБЛИЧНОЙ СТРАНИЦЫ (`app/pages/s/[token].vue`), а не общий компонент портала:
 * тот же отдельный мир — тёмный лист заказчика, свой CSP, никакого знания о REST. Из набора
 * здесь только виджет вопроса, как и на самой странице.
 *
 * ⚠ ДАТА — КАЛЕНДАРЁМ, А НЕ ТЕКСТОМ (issue #84, п. 13). До этого вопрос «Дата» падал
 * в текстовое поле, и клиент мог написать что угодно: «в пятницу», «28.09», «не знаю». Такое
 * нельзя ни показать датой в карточке, ни сравнить с другой датой. Сам `B24InputDate` — поле
 * из трёх частей «дд.мм.гггг» без календаря; календарь к нему приделан так, как это делает
 * документация набора (пример «As a date picker»): `B24Calendar` во всплывающем `B24Popover`.
 *
 * ⚠ ОТДЕЛЬНЫМ ФАЙЛОМ — РАДИ ТОГО, ЧТОБЫ ГРУЗИТЬСЯ ЛЕНИВО. Страница берёт его как
 * `LazySurveyDateInput`, и код поля с календарём уходит с пути, который страница ждёт, прежде
 * чем ожить: браузер докачивает его в простое, по подсказке `prefetch`. Замерено на собранном
 * приложении, анкета без даты, скрипты до оживления страницы: на `main` — 437 КБ (155 сжатыми),
 * со статическим импортом — 676 КБ (209), с ленивым — 439 КБ (156). Докачка в простое при этом
 * растёт примерно на те же 200 КБ (45 сжатыми) — она не мешает отвечать, но и не бесплатна.
 * Дата в разобранном наборе есть у одной анкеты из двенадцати.
 *
 * Лениво по отдельности нельзя: календарь, догружаемый при первом открытии, в тестах
 * открывался и тут же закрывался — всплывающее окно успевало решить, что щелчок был снаружи.
 * Одним куском с полем он приезжает раньше, чем его откроют.
 *
 * Отдаёт наружу строку `ГГГГ-ММ-ДД` или `null` — объект даты живёт только здесь, — и признак
 * «дата не дописана», по которому страница не отправит анкету.
 */

const props = defineProps<{
  /** Идентификатор подписи вопроса: связь по нему, а не текстом формулировки в атрибуте. */
  labelledby: string
}>()

const emit = defineEmits<{
  /** The answer: a day in wire form, or `null` for «не ответил». */
  answer: [value: string | null]
  /** Whether the field holds a date typed only in part: the page must not send the survey then. */
  incomplete: [value: boolean]
}>()

/** A date as the kit's field and calendar understand it: an `@internationalized/date` object. */
type PickedDate = NonNullable<InputDateProps['modelValue']>

/**
 * The chosen date as an object, the form the widget understands.
 *
 * ⚠ Ответ уходит странице строкой, а объект живёт здесь, по образцу ползунка: там положение
 * ручки отдельно от ответа, здесь объект виджета отдельно от строки. Вычислять объект из строки
 * значило бы завести прямую зависимость от `@internationalized/date` ради одного конструктора —
 * а объект виджет и так отдаёт сам.
 *
 * `shallowRef`, а не `ref`: объект даты неизменяем — любая правка возвращает новый, — следить
 * внутри него не за чем, а глубокий `ref` отдавал бы виджету не его объект, а прокси поверх него.
 * Примеры набора держат дату так же.
 *
 * ⚠ Нетронутая дата — `undefined` здесь и `null` на странице, как и нетронутый ползунок:
 * подставлять «сегодня» нельзя — «нет ответа» не равно ответу, который выбрали за человека.
 */
const picked = shallowRef<PickedDate>()

/** Whether the calendar is open. */
const open = ref(false)

/** The field's row: its parts are read to tell «не начинал» from «начал и не дописал». */
const row = useTemplateRef<HTMLDivElement>('row')

/** Whether the hint «дата не дописана» is shown. */
const unfinished = ref(false)

/** The hint's id: the field refers to it, so a screen reader reads it along with the field. */
const hintId = computed(() => `${props.labelledby}-hint`)

/** What to do with a date typed only in part. */
const HINT = `Допишите дату: день, месяц и год от ${ANSWER_YEARS.min} до ${ANSWER_YEARS.max} — или сотрите поле.`

/**
 * The kit's Russian dictionary — for the calendar's button labels («Следующий месяц» and the rest).
 *
 * ⚠ Обычно его раздаёт `<B24App>`, а его на публичной странице нет и быть не должно (гвард
 * в `tests/unit/page-layouts.test.ts`): без этой строки экранный диктор называл бы кнопки
 * календаря по-английски посреди русской анкеты. Ключ — открытый API набора, тот самый,
 * через который словарь раздаёт `<B24App>`.
 */
provide(localeContextInjectionKey, shallowRef(ru))

/**
 * Records the date typed in the field or chosen in the calendar.
 *
 * Стёртое поле приходит `undefined` и уезжает `null`: «не ответил», как у любого вопроса.
 *
 * ⚠ ОТВЕТОМ СТАНОВИТСЯ ТОЛЬКО ДАТА, КОТОРУЮ ПРИМЕТ СЕРВЕР. Поле набора собирает дату после
 * каждой цифры, как только все три части не пусты: год «2026», набранный по цифре, по пути
 * отдаёт 2-й, 20-й и 202-й годы, а «28.09.26» так и остаётся 26-м. Здесь было написано, что
 * «виджет отдаёт значение, только когда дата собрана целиком», и для года это было неправдой:
 * `0026-09-28` уезжал в портал, а ссылка одноразовая. Нашли `/review` и `/code-review` в PR #91.
 * Проверка — та же функция, что на сервере (`shared/answer-date.ts`): расходиться им негде.
 * Всё, что её не прошло, уезжает `null` и становится поводом для подсказки — но только когда
 * человек уйдёт из поля (`leave`), иначе она мигала бы на каждой цифре года.
 */
function pick(value: PickedDate | null | undefined): void {
  picked.value = value ?? undefined
  const day = value ? isoDay(value) : null
  const accepted = day !== null && isCalendarDate(day) ? day : null
  emit('answer', accepted)
  // A finished date clears the hint at once; an unfinished one waits until the field is left.
  if (accepted !== null) settle(false)
}

/**
 * Picks a day in the calendar and closes it.
 *
 * ⚠ Повторный щелчок по уже выбранному дню дату НЕ снимает — на календаре стоит `prevent-deselect`.
 * Прежде снимал: человек открывал календарь проверить дату, «подтверждал» её щелчком — окно
 * закрывалось, будто всё в порядке, а уезжало «не ответил». Нашёл `/code-review` в PR #91.
 * Стереть дату по-прежнему можно в самом поле, как любое поле.
 */
function pickFromCalendar(value: PickedDate | null | undefined): void {
  pick(value)
  open.value = false
}

/**
 * Whether the date is typed only in part: some parts are filled, yet there is no date to send.
 *
 * ⚠ По разметке поля, а не по значению: частичную дату поле набора наружу не отдаёт вовсе —
 * значение пустое, пока не заполнены все три части, — и «28.09.гггг» молча уезжала бы как
 * «не ответил» при «Спасибо!» на экране. Прежде текстовое поле принимало «28.09», и человек
 * по привычке набирает так же. Нашли `/review` и `/code-review` в PR #91. Пустую часть поле
 * помечает `data-placeholder` (`reka-ui`, `useDateField.js`) — тот же признак, по которому
 * стили ниже красят подсказку «дд.мм.гггг».
 */
function typedInPart(): boolean {
  const parts = row.value?.querySelectorAll('[data-segment]:not([data-segment="literal"])') ?? []
  const filled = [...parts].some(part => !part.hasAttribute('data-placeholder'))
  const complete = picked.value !== undefined && isCalendarDate(isoDay(picked.value))
  return filled && !complete
}

/** Shows or hides the hint and tells the page, once per change. */
function settle(value: boolean): void {
  if (unfinished.value === value) return
  unfinished.value = value
  emit('incomplete', value)
}

/**
 * Checks the field once focus leaves it.
 *
 * Переход между частями поля (день → месяц) — не уход из поля: такие переходы пропускаются.
 * Календарь всплывает в `body`, вне поля, и уход в него считается уходом, но выбранный там день
 * снимет подсказку сам (`pick`). Кнопка «Отправить» получает фокус раньше, чем нажатие, так что
 * к отправке признак уже на месте.
 */
function leave(event: FocusEvent): void {
  const next = event.relatedTarget
  if (next instanceof Node && row.value?.contains(next)) return
  settle(typedInPart())
}

/**
 * Checks the field on demand — the page calls it right before sending.
 *
 * ⚠ Уход фокуса — не опора для отправки. В WebKit на iOS, то есть и в мобильном клиенте
 * Битрикс24, нажатие кнопки не обязано уводить фокус из поля: «Отправить» сработала бы раньше,
 * чем поле заметило недописанную дату. Поэтому страница перед отправкой спрашивает каждое поле
 * сама, а подсказка по уходу фокуса — только чтобы сказать раньше.
 */
function check(): void {
  settle(typedInPart())
}

defineExpose({ check })
</script>

<template>
  <!--
    ⚠ Обёртка нужна стилям, а не вёрстке: у `B24InputDate` в корне шаблона два узла, и Vue
    не ставит на такой корень атрибут `scoped`-стилей. Правило на классе поля молча
    не применялось — см. разбор у стилей ниже.
  -->
  <div
    ref="row"
    class="date-row"
    @focusout="leave"
  >
    <!--
      ⚠ `locale="ru"` на поле и на календаре обязателен. Без `<B24App>` набор считает локаль
      английской, и поле встало бы в американском порядке «мм/дд/гггг»: человек, набравший
      «10.09» по-русски, получил бы 9 октября.

      `:range="false"` и `:multiple="false"` — не настройка, а подсказка типам: без них набор
      объявляет, что может прислать и диапазон, и список дат.
    -->
    <B24InputDate
      class="date"
      color="air-primary-success"
      locale="ru"
      :range="false"
      :model-value="picked"
      :aria-labelledby="props.labelledby"
      :aria-describedby="hintId"
      @update:model-value="pick"
    >
      <template #trailing>
        <B24Popover v-model:open="open">
          <!--
            Кнопка, открывающая календарь, — своя, как и сброс у ползунка: значок из тех же
            контуров, что в шапке страницы, а не пакет иконок ради одного глифа. Имя ей даёт
            свой текст, связь с вопросом — идентификатор, а не формулировка в атрибуте.
          -->
          <button
            type="button"
            class="pick"
            :aria-describedby="props.labelledby"
          >
            <span class="visually-hidden">Выбрать дату в календаре</span>
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4" />
            </svg>
          </button>

          <!--
            `calendar-label` доходит до календаря `reka-ui` под набором: без него диктор начинал
            календарь словами «Event Date» — словарь набора эту подпись не переводит,
            в отличие от подписей кнопок.
          -->
          <template #content>
            <B24Calendar
              class="calendar"
              color="air-primary-success"
              locale="ru"
              calendar-label="Календарь"
              prevent-deselect
              :range="false"
              :multiple="false"
              :model-value="picked"
              @update:model-value="pickFromCalendar"
            />
          </template>
        </B24Popover>
      </template>
    </B24InputDate>
    <!-- Живая область стоит всегда, меняется только текст: появившуюся уже с текстом дикторы
         часто не зачитывают (урок PR #89). -->
    <p
      :id="hintId"
      class="hint"
      role="status"
    >
      {{ unfinished ? HINT : '' }}
    </p>
  </div>
</template>

<style scoped>
/*
  ⚠ Поле даты — по тем же правилам, что текстовое поле страницы, и по той же причине: на тёмном
  листе заказчика поле набора в своих цветах было бы чужим. Белое, с тёмным текстом, той же
  рамкой и тем же скруглением — два поля одной анкеты не должны выглядеть взятыми из двух
  макетов. Поэтому цвета не литералами, а переменными `--field-*`, которые объявляет лист
  страницы (`.page` в `app/pages/s/[token].vue`), — прежде они были скопированы, и правка макета
  в одном месте молча развела бы поля (`/code-review`, PR #91). Во всю ширину поле
  не растягиваем: в дате десять знаков, и поле на весь лист читалось бы приглашением написать абзац.

  ⚠ Правила идут ЧЕРЕЗ `.date-row :deep(…)`, а не на `.date` напрямую. У `B24InputDate` в корне
  шаблона два узла, и Vue не ставит на такой корень атрибут области видимости стилей: правило
  `.date { … }` молча не применялось, и поле оставалось в цветах набора. Видно было только
  в собранной странице — computed-стили показали рамку `0px` и радиус набора вместо нашего.

  Подсказка «дд.мм.гггг» темнее умолчания набора: его светло-серый на белом почти не читается,
  а здесь это единственное, что говорит человеку, в каком порядке набирать дату.
*/
.date-row {
  margin-top: 0.4rem;
}

.date-row :deep(.date) {
  border: 1px solid var(--field-line);
  border-radius: var(--field-radius);
  background: var(--field-bg);
}

.date-row :deep([data-segment]) {
  color: var(--field-ink);
}

.date-row :deep([data-segment][data-placeholder]),
.date-row :deep([data-segment="literal"]) {
  color: #6a737f;
}

.pick {
  display: flex;
  padding: 0;
  border: 0;
  background: none;
  color: #6a737f;
  cursor: pointer;
}

.pick:hover,
.pick:focus-visible {
  color: var(--field-ink);
}

.pick svg {
  width: 1.25rem;
  height: 1.25rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/*
  Имя для экранного диктора, но не для глаза — тот же приём, что у сброса ползунка на странице
  (`.visually-hidden` в `app/pages/s/[token].vue`). Копия, а не общий класс: стили страницы
  `scoped` и до компонента не доходят. Правится — то в обоих местах; значок календаря в кнопке
  тоже повторяет контур из шапки страницы.
*/
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Подсказка о недописанной дате — цветом претензий страницы; пустая места не занимает. */
.hint {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  color: var(--alert);
}

.hint:empty {
  margin: 0;
}

/*
  Календарь всплывает поверх листа и остаётся карточкой набора — белой, как само поле.
  Отступ — тот же, что в примере документации (`p-2`): без него числа жмутся к краю.
*/
.calendar {
  padding: 0.5rem;
}
</style>
