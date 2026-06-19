import { SurveyFill } from '~core/client/survey-fill'
import type { PublicVersion, Question } from '~core/domain/schema'
import type { QuestionAnswer } from '~core/client/survey-fill'

/**
 * Реактивная обёртка прохождения опроса (контур A). Вся логика — в ядровом `SurveyFill`
 * (навигация/валидация шага/«Другое»/exclusive/маппинг в Submission); композабл лишь
 * оборачивает её Vue-реактивностью и зовёт публичные `/api/*` через `$fetch` (Nuxt-клиент).
 * Импорт из ядра — только `~core/client` (SurveyFill) и `~core/domain` (типы): чистая
 * логика без секретов, клиентский импорт разрешён (граница `~core`, см. CLAUDE.md).
 *
 * РЕАКТИВНОСТЬ (важно при правке!): `SurveyFill` хранит состояние в обычном поле и меняет
 * его по ссылке — Vue этого не видит. Поэтому реактивность завязана на счётчик `tick`:
 * `view` зависит от `tick`, и КАЖДАЯ мутация `fill` (`selectOption`/`next`/`back`/…) ОБЯЗАНА
 * сопровождаться `bump()`. Снимете `bump` — UI «застынет». Решение зафиксировано в
 * docs/decisions.md (почему обёртка, а не реактивный объект внутри ядра).
 *
 * Загрузку версии делает СТРАНИЦА через `useAsyncData` (SSR-payload + дедуп + рефетч при
 * смене `:key`); сюда версия/ошибка приходят через `reset()`. Persist-снимок (localStorage)
 * ядро умеет (`snapshot`/restore), но здесь пока не подключён — вынесено в #34.
 */
export type SurveyPhase = 'loading' | 'error' | 'intro' | 'survey' | 'thanks'

export interface SurveyView {
  question: Question
  answer: QuestionAnswer
  progress: { current: number; total: number }
  isFirst: boolean
  isLast: boolean
  showError: boolean
  canAdvance: boolean
}

export function useSurvey() {
  const version = shallowRef<PublicVersion | null>(null)
  const fill = shallowRef<SurveyFill | null>(null)
  const phase = ref<SurveyPhase>('loading')
  const errorMsg = ref('')
  const submitting = ref(false)
  const tick = ref(0)
  const bump = () => { tick.value++ }

  /** Применить результат загрузки версии (из useAsyncData страницы). Реактивен к смене :key. */
  function reset(nextVersion: PublicVersion | null, fetchError?: unknown) {
    fill.value = null
    if (fetchError) {
      const code = (fetchError as { statusCode?: number }).statusCode
      errorMsg.value = code === 404 ? 'Опрос не найден или больше не активен.' : 'Не удалось загрузить опрос.'
      version.value = null
      phase.value = 'error'
    } else {
      version.value = nextVersion
      errorMsg.value = ''
      phase.value = nextVersion ? 'intro' : 'error'
    }
    bump()
  }

  function start() {
    if (!version.value) return
    // PublicVersion присваиваем как CompiledVersion: invitationPolicy опционален, его отсутствие
    // допустимо; SurveyFill его не читает (только презентацию/вопросы).
    fill.value = new SurveyFill(version.value)
    errorMsg.value = ''
    phase.value = 'survey'
    bump()
  }

  const view = computed<SurveyView | null>(() => {
    void tick.value
    const f = fill.value
    if (!f) return null
    return {
      question: f.currentQuestion,
      answer: f.currentAnswer,
      progress: f.progress,
      isFirst: f.isFirst,
      isLast: f.isLast,
      showError: f.state.showError,
      canAdvance: f.canAdvance
    }
  })

  const selectOption = (optionKey: string) => { fill.value?.selectOption(optionKey); bump() }
  const setOther = (text: string) => { fill.value?.setOther(text); bump() }
  const setText = (text: string) => { fill.value?.setText(text); bump() }
  const back = () => { fill.value?.back(); bump() }

  /** «Далее»/«Отправить»: на последнем валидном шаге уходит в submit. */
  async function next() {
    const f = fill.value
    if (!f) return
    const wasLast = f.isLast
    const ok = f.next()
    bump()
    if (ok && wasLast) await submit()
  }

  async function submit() {
    const f = fill.value
    if (!f || submitting.value) return
    submitting.value = true
    errorMsg.value = ''
    try {
      const sess = await $fetch<{ nonce: string; schema_version: number }>('/api/session')
      const sub = f.toSubmission()
      await $fetch('/api/submit', {
        method: 'POST',
        body: {
          schema_version: sess.schema_version,
          nonce: sess.nonce,
          hp: '',
          surveyKey: sub.surveyKey,
          versionNo: sub.versionNo,
          answers: sub.answers
        }
      })
      phase.value = 'thanks'
    } catch {
      // Остаёмся на опросе, показываем ошибку отправки (nonce одноразов — повтор берёт новый).
      errorMsg.value = 'Не удалось отправить ответы. Проверьте соединение и попробуйте ещё раз.'
    } finally {
      submitting.value = false
    }
  }

  return {
    version, phase, errorMsg, submitting, view,
    reset, start, selectOption, setOther, setText, back, next, submit
  }
}
