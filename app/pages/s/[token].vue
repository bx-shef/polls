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

interface SurveyResponse {
  ok: boolean
  reason?: string
  title?: string
  detail?: string
  survey?: {
    title: string
    sections: { key: string, title: string, questions: PublicQuestion[] }[]
  }
}

const route = useRoute()
const token = String(route.params.token ?? '')

useHead({
  // `noindex` стоит и заголовком от сервера, и здесь: заголовок ставит наш плагин,
  // а мета переживёт случай, когда страницу сохранили и открыли из файла.
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})

const { data, error } = await useFetch<SurveyResponse>(`/api/s/${token}`)

/**
 * Ответы. Значение `null` — «не ответил», и оно НЕ равно нулю.
 *
 * Балльный вопрос не имеет предустановленного значения — инвариант проекта. Именно поэтому
 * шкала собрана кнопками, а не `<input type="range">`: у нативного ползунка значение есть
 * всегда, он открывается посередине шкалы, и «не тронул» от «поставил 5» не отличить.
 * Ровно это и случилось в старом решении заказчика, только там нетронутое уезжало нулём.
 */
const answers = reactive<Record<string, number | string | null>>({})
const sending = ref(false)
const sent = ref(false)
const problems = ref<{ key: string, detail: string }[]>([])
const failure = ref('')

const survey = computed(() => data.value?.survey)
const denial = computed(() => (data.value && !data.value.ok ? data.value : null))

/** Абзацы формулировки. Заголовок вопроса — абзац, а не ярлык: в разобранном наборе они длинные. */
function paragraphs(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** Деления шкалы: от нижней границы до верхней включительно. */
function steps(question: PublicQuestion): number[] {
  const min = question.scale?.min ?? 0
  const max = question.scale?.max ?? 10
  return Array.from({ length: max - min + 1 }, (_, i) => min + i)
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
    const result = await $fetch<{ ok: boolean, reason?: string, title?: string, detail?: string, problems?: { key: string, detail: string }[] }>(
      `/api/s/${token}`,
      { method: 'POST', body: answers },
    )
    if (result.ok) {
      sent.value = true
      return
    }
    if (result.problems !== undefined) {
      problems.value = result.problems
      return
    }
    failure.value = result.detail ?? 'Не удалось отправить ответы.'
  }
  catch {
    // Что именно сломалось, респонденту знать незачем и неинтересно: ему нужно понять,
    // что делать дальше. Подробности — в журнале сервера.
    failure.value = 'Не удалось отправить ответы. Проверьте связь и попробуйте ещё раз.'
  }
  finally {
    sending.value = false
  }
}
</script>

<template>
  <main class="page">
    <div
      v-if="error"
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

    <form
      v-else-if="survey"
      class="card"
      @submit.prevent="submit"
    >
      <h1>{{ survey.title }}</h1>

      <section
        v-for="section in survey.sections"
        :key="section.key"
        class="section"
      >
        <h2>{{ section.title }}</h2>

        <fieldset
          v-for="question in section.questions"
          :key="question.key"
          class="question"
        >
          <legend>
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
          >
            <button
              v-for="step in steps(question)"
              :key="step"
              type="button"
              class="step"
              :class="{ picked: answers[question.key] === step }"
              :aria-pressed="answers[question.key] === step"
              @click="answers[question.key] = answers[question.key] === step ? null : step"
            >
              {{ step }}
            </button>
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

      <button
        type="submit"
        class="send"
        :disabled="sending"
      >
        {{ sending ? 'Отправляем…' : 'Отправить ответы' }}
      </button>
      <p class="note">
        Ответить можно один раз. Незаполненные вопросы останутся без ответа — это нормально.
      </p>
    </form>
  </main>
</template>

<style scoped>
/*
  Своя вёрстка, без набора компонентов: страница живёт вне портала. Ширина и размеры
  рассчитаны на телефон в первую очередь — по ссылке из письма заходят с него.
*/
.page {
  max-width: 44rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
}

.card {
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  padding: 1.25rem;
}

h1 {
  margin: 0 0 0.75rem;
  font-size: 1.35rem;
  line-height: 1.3;
}

h2 {
  margin: 2rem 0 0.5rem;
  font-size: 1.05rem;
  color: var(--muted);
  font-weight: 600;
}

.section:first-of-type h2 {
  margin-top: 1.25rem;
}

.question {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 0;
  padding: 1rem 0 0;
}

legend {
  padding: 0;
  margin-bottom: 0.75rem;
}

.line {
  display: block;
}

.muted {
  color: var(--muted);
}

/* Деления шкалы переносятся, а не сжимаются: на узком экране одиннадцать кнопок в строку
   превратились бы в нажимаемые только ногтем. */
.scale {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.step {
  min-width: 2.75rem;
  min-height: 2.75rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: transparent;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.step.picked {
  border-color: var(--ok);
  background: var(--ok);
  color: var(--bg);
}

.text {
  width: 100%;
  padding: 0.6rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: transparent;
  color: var(--fg);
  font: inherit;
  resize: vertical;
}

.counter {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  color: var(--muted);
}

.counter.over {
  color: var(--bad);
}

.problem {
  margin: 0.5rem 0 0;
  color: var(--bad);
}

.send {
  margin-top: 1.5rem;
  min-height: 2.75rem;
  padding: 0 1.25rem;
  border: 0;
  border-radius: 0.5rem;
  background: var(--ok);
  color: var(--bg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.send:disabled {
  opacity: 0.6;
  cursor: default;
}

.note {
  margin: 0.75rem 0 0;
  font-size: 0.9rem;
  color: var(--muted);
}
</style>
