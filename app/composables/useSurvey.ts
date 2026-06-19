import { SurveyFill, surveyFillSnapshotSchema } from '~core/client/survey-fill'
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
 * смене `:key`); сюда версия/ошибка приходят через `reset()`.
 *
 * Persist (#34): прогресс кладётся в localStorage (`snapshot()`), `hydrate()` на клиенте
 * восстанавливает его (resume на reload) и поддерживает deep-link `?q=N`. Только клиент
 * (localStorage нет на SSR), restore — в `onMounted` страницы (без hydration-mismatch).
 * Снимок недоверенный → `SurveyFill` валидирует его на границе (safeParse + сверка версии).
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
  // SurveyFill мутирует внутреннее состояние in-place — тик форсит пересчёт computed.
  const tick = ref(0)
  const bump = () => { tick.value++ }

  // Гард пустого ключа: без surveyKey не трогаем localStorage (иначе мина "survey:" на всех опросах).
  const persistKey = () => {
    const k = version.value?.surveyKey
    return k ? `survey:${k}` : null
  }

  function saveSnapshot() {
    const key = persistKey()
    if (!import.meta.client || !fill.value || !key) return
    try {
      localStorage.setItem(key, JSON.stringify(fill.value.snapshot()))
    } catch { /* приватный режим/квота — persist необязателен */ }
  }
  function clearSnapshot() {
    const key = persistKey()
    if (!import.meta.client || !key) return
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  }
  function readSnapshot(): unknown {
    const key = persistKey()
    if (!import.meta.client || !key) return undefined
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : undefined
    } catch { return undefined }
  }

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

  /** Построить fill (опц. из снимка) и перейти в фазу опроса; deep-link → goTo(index). */
  function startFill(restored?: unknown, index?: number) {
    if (!version.value) return
    // composable валидирует снимок на границе (safeParse → SurveyFillSnapshot|undefined);
    // ядро (initState) дополнительно сверяет surveyKey/versionNo — снимок чужого опроса/версии
    // отбрасывается (старт с нуля). Кривой снимок → undefined → свежий проход.
    fill.value = restored === undefined
      ? new SurveyFill(version.value)
      : new SurveyFill(version.value, surveyFillSnapshotSchema.safeParse(restored).data)
    if (index !== undefined) fill.value.goTo(index)
    errorMsg.value = ''
    phase.value = 'survey'
    bump()
    saveSnapshot()
  }

  /** «Начать» с интро — всегда свежий проход (опц. deep-link `?q`). */
  function start(index?: number) {
    startFill(undefined, index)
  }

  /**
   * Клиентская гидратация (вызвать в onMounted страницы): resume из localStorage и/или
   * deep-link `?q=N`. Срабатывает только из исходной фазы intro (SSR-рендер).
   */
  function hydrate(deepLinkIndex?: number) {
    if (phase.value !== 'intro' || !version.value) return
    const snap = readSnapshot()
    if (snap !== undefined) {
      // Resume важнее deep-link: у вернувшегося пользователя сохранённая позиция приоритетнее
      // ?q из ссылки (не теряем прогресс, не создаём гибрид). current берётся из снимка (initState).
      startFill(snap)
      return
    }
    if (deepLinkIndex !== undefined) startFill(undefined, deepLinkIndex)
    // иначе — остаёмся на интро (свежий старт по кнопке)
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

  const selectOption = (optionKey: string) => { fill.value?.selectOption(optionKey); bump(); saveSnapshot() }
  const setOther = (text: string) => { fill.value?.setOther(text); bump(); saveSnapshot() }
  const setText = (text: string) => { fill.value?.setText(text); bump(); saveSnapshot() }
  const back = () => { fill.value?.back(); bump(); saveSnapshot() }

  /** «Далее»/«Отправить»: на последнем валидном шаге уходит в submit. */
  async function next() {
    const f = fill.value
    if (!f) return
    const wasLast = f.isLast
    const ok = f.next()
    bump()
    saveSnapshot()
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
      clearSnapshot() // опрос завершён — прогресс больше не восстанавливаем
      phase.value = 'thanks'
    } catch {
      // Остаёмся на опросе, показываем ошибку отправки. Снимок НЕ чистим — намеренно: повтор
      // не теряет ответы (nonce одноразов, повтор берёт новый через /api/session).
      errorMsg.value = 'Не удалось отправить ответы. Проверьте соединение и попробуйте ещё раз.'
    } finally {
      submitting.value = false
    }
  }

  return {
    version, phase, errorMsg, submitting, view,
    reset, start, hydrate, selectOption, setOther, setText, back, next, submit
  }
}
