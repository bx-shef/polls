<script setup lang="ts">
/**
 * The public survey page. A separate world from the rest of the app.
 *
 * Здесь нет ни одного компонента `b24ui`, и это не упущение: страницу открывает посторонний
 * респондент вне портала, у неё своя вёрстка, свой CSP и никакого знания о REST Битрикс24.
 * Данные приходят из нашего же `/api/s/<токен>`, который уже решил, что показывать.
 *
 * ⚠ Текст, пришедший с портала, рендерится ТОЛЬКО интерполяцией `{{ }}`. Никакого `v-html`
 * и никакой библиотеки разметки: формулировку вопроса пишет сотрудник портала, а читает её
 * посторонний человек — это прямой путь для XSS, и закрывается он тем, что разметки здесь
 * не бывает вовсе.
 */

interface PublicQuestion {
  key: string
  title: string
  type: 'scale' | 'text' | 'date'
  scale?: { min: number, max: number }
}

interface PublicHeader {
  company: string
  project: string
  respondent: string
  manager: string
  issuedAt: string
}

interface SurveyResponse {
  ok?: boolean
  reason?: string
  title?: string
  detail?: string
  header?: PublicHeader | null
  survey?: {
    title: string
    sections: { key: string, title: string, questions: PublicQuestion[] }[]
  }
}

interface SubmitResponse {
  ok?: boolean
  detail?: string
  problems?: { key: string, detail: string }[]
}

const GENERIC_FAILURE = 'Не удалось отправить ответы. Проверьте связь и попробуйте ещё раз.'

const route = useRoute()
const token = String(route.params.token ?? '')

useHead({
  // `noindex` стоит и заголовком от сервера, и здесь: заголовок ставит наш плагин,
  // а мета переживёт случай, когда страницу сохранили и открыли из файла.
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})

/**
 * ⚠ `ignoreResponseError` обязателен. Без него `useFetch` считает любой не-2xx ошибкой
 * и ВЫБРАСЫВАЕТ тело — а именно телом мы объясняем человеку, что ссылка истекла или что
 * он частит. Ровно эта ловушка уже ловилась в `app/pages/index.vue`; здесь её нашла панель
 * ревью PR #15: ветка с разбором ответа была недостижима.
 *
 * Обратная сторона: сюда же попадают стандартные ошибки Nitro (503, когда у нас нет базы
 * или схемы анкеты). У них нет ни `ok`, ни `title` — поэтому ниже проверяется форма тела,
 * а не только код.
 */
const { data, error } = await useFetch<SurveyResponse>(`/api/s/${token}`, { ignoreResponseError: true })

/**
 * Ответы. Значение `null` — «не ответил», и оно НЕ равно нулю.
 *
 * ⚠ Балльный вопрос не имеет предустановленного значения — инвариант проекта, и ползунок
 * ему не противоречит РОВНО ПОТОМУ, что нетронутый показывает «—», а не число. У ползунка
 * значение есть всегда, и старое решение заказчика на этом и погорело: нетронутый стоял
 * на нуле и уезжал на сервер честным нулём. README присланного архива называет это первым
 * же пунктом раздела «что видно по дизайну». Здесь состояние «не отвечал» живёт отдельно
 * от положения ручки: в `answers` лежит `null`, ручка стоит у левого края, подпись говорит
 * «—», и первое же касание записывает настоящее число — в том числе ноль.
 */
const answers = reactive<Record<string, number | string | null>>({})
const sending = ref(false)
const sent = ref(false)
const problems = ref<{ key: string, detail: string }[]>([])
const failure = ref('')

const survey = computed(() => data.value?.survey)

/**
 * Шапка: компания, проект, дата, кто спрашивает и кого.
 *
 * ⚠ Снимок с момента выпуска ссылки, а не состояние портала: страница о REST не знает.
 * Может отсутствовать целиком — ссылку выпустили до появления снимка либо портал ничего
 * не отдал, — и тогда страница начинается с названия анкеты. Это законный исход.
 */
const header = computed(() => data.value?.header ?? null)

/**
 * Дата опроса — как в макете: `ДД.ММ.ГГГГ ЧЧ:ММ`.
 *
 * ⚠ Считаем сами, а не через `toLocaleString`: на сервере и в браузере респондента разные
 * часовые пояса и разные локали, и SSR отдал бы одну строку, а гидратация подставила другую.
 * Формат ISO приходит с сервера, разбираем его как есть — по UTC, одинаково с обеих сторон.
 */
function issuedAtLabel(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${at.getUTCFullYear()}`
    + ` ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
}

/** Отказ, который мы умеем объяснить. Тело без `title` — это чужая ошибка, а не наш отказ. */
const denial = computed(() => {
  const body = data.value
  if (body === null || body === undefined) return null
  if (body.ok === true) return null
  return typeof body.title === 'string' && body.title !== '' ? body : null
})

/** Показать общую карточку: сеть отвалилась либо сервер ответил тем, чего мы не ждали. */
const broken = computed(() => error.value !== null && error.value !== undefined
  ? true
  : data.value !== null && data.value !== undefined && data.value.ok !== true && denial.value === null)

/** Абзацы формулировки. Заголовок вопроса — абзац, а не ярлык: в разобранном наборе они длинные. */
function paragraphs(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** Границы шкалы вопроса. Умолчание — привычные 0…10 старого решения. */
function bounds(question: PublicQuestion): { min: number, max: number } {
  return { min: question.scale?.min ?? 0, max: question.scale?.max ?? 10 }
}

/**
 * Где стоит ручка ползунка.
 *
 * ⚠ У нетронутого вопроса ручка стоит у НИЖНЕЙ границы, но ответом это не является:
 * ответ лежит в `answers` и равен `null`. Разводить эти два состояния обязательно —
 * иначе «не тронул» неотличимо от «поставил минимум», и мы повторили бы дефект,
 * ради которого весь инвариант и заведён.
 */
function knobAt(question: PublicQuestion): number {
  const value = answers[question.key]
  return typeof value === 'number' ? value : bounds(question).min
}

/** Подпись справа от ползунка: число либо «—», если вопрос не трогали. */
function scaleLabel(question: PublicQuestion): string {
  const value = answers[question.key]
  return typeof value === 'number' ? String(value) : '—'
}

/** Сколько байт занял текстовый ответ. Предел на сервере в байтах, и считать надо так же. */
function usedBytes(key: string): number {
  const value = answers[key]
  return typeof value === 'string' ? new TextEncoder().encode(value).length : 0
}

const MAX_TEXT_BYTES = 8 * 1024

async function submit() {
  if (sending.value) return
  sending.value = true
  problems.value = []
  failure.value = ''

  try {
    // ⚠ `ignoreResponseError` и здесь по той же причине: 422 (ответы не прошли проверку)
    // и 429 (частит) — это не сбой, а разговор с человеком, и весь смысл в теле ответа.
    const result = await $fetch<SubmitResponse>(`/api/s/${token}`, {
      method: 'POST',
      body: answers,
      ignoreResponseError: true,
    })
    if (result?.ok === true) {
      sent.value = true
      return
    }
    if (result?.problems !== undefined && result.problems.length > 0) {
      problems.value = result.problems
      return
    }
    if (typeof result?.detail === 'string' && result.detail !== '') {
      failure.value = result.detail
      return
    }
    failure.value = GENERIC_FAILURE
  }
  catch {
    // Сюда доходит только то, что не доехало до сервера: сеть, обрыв. Что именно сломалось,
    // респонденту знать незачем — ему нужно понять, что делать дальше.
    failure.value = GENERIC_FAILURE
  }
  finally {
    sending.value = false
  }
}
</script>

<template>
  <main class="page">
    <!--
      Шапка: компания крупно, под ней три блока — что за опрос и по какому проекту,
      когда и кто спрашивает, кого спрашиваем. Ровно как в макете старого решения.

      ⚠ Рисуется только над самой анкетой. На отказе и на «спасибо» она была бы не к месту:
      человеку в этот момент нужна одна фраза, а не реквизиты. Отсутствует целиком, когда
      снимка нет, — тогда страница начинается с названия анкеты, как и раньше.
    -->
    <header
      v-if="survey && header && !sent"
      class="masthead"
    >
      <h1
        v-if="header.company"
        class="company"
      >
        {{ header.company }}
      </h1>
      <div class="facts">
        <div class="fact">
          <svg
            class="glyph"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />
          </svg>
          <div class="lines">
            <div class="caption">
              {{ survey.title }}
            </div>
            <div
              v-if="header.project"
              class="value"
            >
              {{ header.project }}
            </div>
          </div>
        </div>

        <div class="fact">
          <svg
            class="glyph"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4" />
          </svg>
          <div class="lines">
            <div class="caption">
              {{ issuedAtLabel(header.issuedAt) }}
            </div>
            <div
              v-if="header.manager"
              class="value"
            >
              {{ header.manager }}
            </div>
          </div>
        </div>

        <div
          v-if="header.respondent"
          class="fact"
        >
          <svg
            class="glyph"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" />
          </svg>
          <div class="lines">
            <div class="value">
              {{ header.respondent }}
            </div>
          </div>
        </div>
      </div>
    </header>

    <div
      v-if="broken"
      class="card"
    >
      <h1>Анкета недоступна</h1>
      <p>Попробуйте открыть ссылку позже. Если не получится — попросите прислать её заново.</p>
    </div>

    <div
      v-else-if="sent"
      class="card"
    >
      <h1>Спасибо!</h1>
      <p>Ваши ответы получены. Закрывать страницу можно — ничего отправлять больше не нужно.</p>
    </div>

    <div
      v-else-if="denial"
      class="card"
    >
      <h1>{{ denial.title }}</h1>
      <p>{{ denial.detail }}</p>
    </div>

    <!--
      Полоса с брендовой картинкой слева и анкета справа — раскладка макета. Полоса
      декоративная и потому `aria-hidden`: экранному диктору в ней нечего читать,
      а фоном она не встанет, если картинку не отдали, — колонка просто схлопнется.
    -->
    <div
      v-else-if="survey"
      class="sheet"
    >
      <div
        class="strip"
        aria-hidden="true"
      />

      <form
        class="card"
        @submit.prevent="submit"
      >
        <h1 v-if="!header">
          {{ survey.title }}
        </h1>

        <section
          v-for="(section, si) in survey.sections"
          :key="section.key"
          class="section"
        >
          <h2>{{ section.title }}</h2>

          <fieldset
            v-for="(question, qi) in section.questions"
            :key="question.key"
            class="question"
          >
            <legend :id="`q${si}-${qi}`">
              <span
                v-for="(line, i) in paragraphs(question.title)"
                :key="i"
                class="line"
              >{{ line }}</span>
              <span
                v-if="paragraphs(question.title).length === 0"
                class="line muted"
              >{{ question.key }}</span>
            </legend>

            <div
              v-if="question.type === 'scale'"
              class="scale"
              :class="{ untouched: typeof answers[question.key] !== 'number' }"
            >
              <!--
              ⚠ Подпись ползунка связывается ПО ИДЕНТИФИКАТОРУ, а не кладётся текстом
              в `aria-label`. Формулировку пишет сотрудник портала, и в значении атрибута
              она никем как разметка не читается — но сериализация HTML не экранирует там
              `<`, поэтому такой атрибут ВЫГЛЯДИТ как разметка в любом дампе и снимает
              гвард «разметки на этой странице не бывает». Идентификатор собирается из
              номеров секции и вопроса, то есть целиком наш: с портала в атрибуты
              не уезжает ничего.
            -->
              <B24Range
                class="range"
                color="air-primary-success"
                :min="bounds(question).min"
                :max="bounds(question).max"
                :step="1"
                :model-value="knobAt(question)"
                :aria-labelledby="`q${si}-${qi}`"
                @update:model-value="answers[question.key] = Number($event)"
              />
              <output class="value">{{ scaleLabel(question) }}</output>
            </div>

            <template v-else>
              <textarea
                v-model="answers[question.key] as string"
                class="text"
                rows="4"
              />
              <p
                v-if="usedBytes(question.key) > MAX_TEXT_BYTES * 0.75"
                class="counter"
                :class="{ over: usedBytes(question.key) > MAX_TEXT_BYTES }"
              >
                {{ usedBytes(question.key) }} из {{ MAX_TEXT_BYTES }} байт
              </p>
            </template>
          </fieldset>
        </section>

        <p
          v-for="problem in problems"
          :key="problem.key"
          class="problem"
        >
          {{ problem.detail }}
        </p>
        <p
          v-if="failure"
          class="problem"
        >
          {{ failure }}
        </p>

        <p class="note">
          Ответить можно один раз. Незаполненные вопросы останутся без ответа — это нормально.
        </p>
        <div class="send-row">
          <button
            type="submit"
            class="send"
            :disabled="sending"
          >
            {{ sending ? 'Отправляем…' : 'Отправить' }}
          </button>
        </div>
        <p class="thanks">
          Спасибо за ваше время!
        </p>
      </form>
    </div>
  </main>
</template>

<style scoped>
/*
  Дизайн взят с реконструкции старого решения (архив владельца 23.09) и от неё же
  отличается в одном месте — см. `.scale.untouched` ниже.

  ⚠ СТРАНИЦА ТЁМНАЯ ВСЕГДА, а не следует системной теме. Правило проекта требует обеих тем,
  и для портальных экранов это верно: там сотрудник работает целый день и тема — его личная
  настройка. Здесь другой человек и другой случай: респондент открывает страницу один раз
  на минуту, по ссылке из письма, и это фирменный бланк заказчика. Светлый вариант того же
  макета — второй дизайн, которого никто не рисовал, а не «та же страница посветлее».

  Своя вёрстка, без набора компонентов, — кроме ползунка: он `B24Range` из `b24ui`,
  потому что виджеты вопросов общие с порталом.
*/
.page {
  --sheet: #2c2c36;
  --ink: #fffdf5;
  --ink-dim: rgba(255, 253, 245, 0.5);
  --mint: #25ce51;

  min-height: 100vh;
  background: var(--sheet);
  color: var(--ink);
  padding: 3.75rem 1rem 3rem;
}

/* Ширина колонки — из макета (`g-max-width-750`). */
.card {
  max-width: 46.875rem;
  margin: 0 auto;
}

/*
  ─── Шапка ────────────────────────────────────────────────────────────────────────
  Компания крупно по центру, под ней три блока с иконками. Пропорции из макета:
  60 px на компанию, 14 px на верхнюю строку блока и 15 px на нижнюю.
*/
.masthead {
  max-width: 46.875rem;
  margin: 0 auto 3.75rem;
}

.company {
  margin: 0 0 3.75rem;
  font-size: 3.75rem;
  line-height: 1.05;
  font-weight: 700;
  text-align: center;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
}

.fact {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  /* Три в ряд на десктопе, в столбик на телефоне — как `col-md-4` в макете. */
  flex: 1 1 13rem;
  min-width: 0;
}

/*
  Иконки — свои контуры, а не шрифт со значками. В макете стоял FontAwesome, но тянуть
  ради трёх глифов внешний шрифт на страницу с узким CSP значит либо расширять политику,
  либо возить сотню килобайт. Контуры весят строки.
*/
.glyph {
  flex: none;
  width: 1.7rem;
  height: 1.7rem;
  fill: none;
  stroke: var(--ink-dim);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lines {
  min-width: 0;
}

.caption {
  margin-bottom: 0.3rem;
  font-size: 0.85rem;
  font-weight: 700;
  line-height: 1.25;
  text-transform: uppercase;
  color: var(--ink-dim);
}

.fact .value {
  font-size: 0.95rem;
  line-height: 1.25;
}

/*
  ─── Полоса с картинкой ───────────────────────────────────────────────────────────
  В макете это `col-md-3` с фоном, повторяющимся по вертикали. Повтор обязателен:
  анкета бывает длиной в три экрана, а картинка — высотой в один.
*/
.sheet {
  display: flex;
  align-items: stretch;
  gap: 0;
}

.strip {
  flex: 0 0 25%;
  max-width: 17rem;
  background-image: url("/brand/survey-strip.jpg");
  background-repeat: repeat-y;
  background-position: center top;
}

.sheet .card {
  flex: 1;
  min-width: 0;
  /* В макете у правой колонки `p-5`, то есть 3rem: без них текст жмётся к картинке. */
  padding: 0 3rem;
  margin: 0;
}

h1 {
  margin: 0 0 3.75rem;
  font-size: 2rem;
  line-height: 1.2;
  font-weight: 700;
  text-align: center;
}

/* Заголовок секции — заглавными и без лишнего веса, как в макете. */
h2 {
  margin: 0 0 0.75rem;
  font-size: 1.25rem;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.01em;
}

.section + .section {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid rgba(255, 253, 245, 0.15);
}

/* Вопросы с отступом от заголовка секции — характерная черта макета. */
/*
  Отступ СНИЗУ обязателен, и это не косметика: без него подпись следующего вопроса встаёт
  вплотную к ползунку предыдущего и читается как его пояснение. На снимке первой редакции
  это видно сразу — глаз склеивает чужую пару.
*/
.question {
  border: 0;
  margin: 0;
  padding: 0.25rem 0 1rem 1.5rem;
}

legend {
  padding: 0;
  font-size: 0.9rem;
  line-height: 1.35;
}

.line {
  display: block;
}

.muted {
  color: var(--ink-dim);
}

/* Ползунок во всю ширину, значение справа — как в макете. */
.scale {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.range {
  flex: 1;
  min-width: 0;
}

/*
  ⚠ Дорожка красится ЦЕЛИКОМ, а не заливается слева направо. Это не вкусовщина: в макете
  (`original-style.css`, `.slider-color.mint`) зелёный — фон всей дорожки, а положение
  показывает только белая ручка. Умолчание набора рисует заполнение от нижней границы,
  и при значении у левого края ползунок выглядит выключенным — ровно то, что видно
  на первом снимке этой переделки.

  Размеры тоже из макета: дорожка 9 px, ручка 25 px. Набор даёт 8 и 16 — на телефоне,
  для которого страница и сделана, в мелкую ручку труднее попасть пальцем.
*/
.range :deep([data-slot="track"]) {
  height: 9px;
  background: var(--mint);
}

.range :deep([data-slot="range"]) {
  background: var(--mint);
}

.range :deep([data-slot="thumb"]) {
  width: 25px;
  height: 25px;
  background: #fff;
  --tw-ring-color: transparent;
}

/*
  Значение фиксированной ширины: иначе колонка цифр прыгает при переходе 9 → 10,
  и глаз цепляется за прыжок вместо самой оценки.
*/
.value {
  min-width: 1.75rem;
  font-weight: 700;
  /* 18 px, как в макете: оценка — то, ради чего человек сюда пришёл, и она крупнее вопроса. */
  font-size: 1.125rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/*
  ⚠ ЕДИНСТВЕННОЕ ОСОЗНАННОЕ ОТЛИЧИЕ ОТ МАКЕТА. В старом решении нетронутый ползунок стоял
  на нуле и показывал «0» — README присланного архива называет это первым же наблюдением
  и выводит из него инвариант нового решения. Здесь нетронутый показывает «—», а дорожка
  у него бледнее: положение ручки у левого края ответом не является, в `answers` лежит `null`.

  ⚠ Приглушается ТОЛЬКО насыщенность зелёного, а не вся строка. Первая редакция гасила
  `opacity: 0.5` на весь блок и красила дорожку в серый — и на первом же снимке стало видно,
  во что это обходится: при открытии анкеты НЕТРОНУТО ВСЁ, то есть страница целиком выглядела
  выключенной, а зелёная дорожка — единственный цвет этого макета — не появлялась вовсе,
  пока человек не начнёт отвечать.
*/
.scale.untouched :deep([data-slot="track"]),
.scale.untouched :deep([data-slot="range"]) {
  background: rgba(37, 206, 81, 0.35);
}

.scale.untouched .value {
  color: var(--ink-dim);
}

.text {
  width: 100%;
  margin-top: 0.4rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid rgba(255, 253, 245, 0.25);
  border-radius: 0.25rem;
  background: #fff;
  color: #17181a;
  font: inherit;
  resize: vertical;
}

.counter {
  margin: 0.35rem 0 0;
  font-size: 0.8rem;
  color: var(--ink-dim);
}

.counter.over {
  color: #ff958c;
}

.problem {
  margin: 0.75rem 0 0;
  color: #ff958c;
  font-size: 0.9rem;
}

.send-row {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid rgba(255, 253, 245, 0.15);
  text-align: center;
}

/* Кнопка — зелёная и небольшая, как в макете: она не главный герой страницы. */
.send {
  padding: 0.3rem 1.2rem 0.4rem;
  border: 0;
  border-radius: 0.25rem;
  background: var(--mint);
  color: #fff;
  font: inherit;
  font-size: 0.95rem;
  cursor: pointer;
}

.send:disabled {
  opacity: 0.6;
  cursor: default;
}

.note {
  margin: 1.5rem 0 0;
  font-size: 0.85rem;
  color: var(--ink-dim);
  text-align: center;
}

.thanks {
  margin: 0.75rem 0 0;
  font-size: 0.85rem;
  text-align: center;
}

/* Телефон в первую очередь: по ссылке из письма заходят с него. */
@media (max-width: 48rem) {
  /*
    ⚠ На телефоне полосы НЕТ ВОВСЕ, и это не упрощение, а то, что делает оригинал: на снимке
    мобильной версии старого решения картинки нет, анкета начинается сразу с первой секции.
    Промежуточная редакция клала её баннером сверху — и сразу стало видно, во что это
    обходится: `cover` растягивает узкую вертикальную картинку до неузнаваемого пятна,
    а на телефон при этом уезжают лишние 290 КБ. `display: none` картинку ещё и не грузит.
  */
  .sheet {
    flex-direction: column;
  }

  .strip {
    display: none;
  }

  .sheet .card {
    padding: 0;
  }

  .company {
    margin-bottom: 2rem;
    font-size: 2.25rem;
  }

  .masthead {
    margin-bottom: 2rem;
  }

  .facts {
    gap: 1rem;
  }

  .fact {
    flex: 1 1 100%;
  }
}

@media (max-width: 30rem) {
  .page {
    padding: 2rem 0.75rem 2.5rem;
  }

  h1 {
    margin-bottom: 2rem;
    font-size: 1.5rem;
  }

  .question {
    padding-left: 0.75rem;
  }
}
</style>
