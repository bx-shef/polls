import { z } from 'zod'
import type { CompiledVersion, Question, RawAnswer, Submission } from '../domain/schema'

/**
 * Framework-agnostic state-machine прохождения опроса клиентом (контур A).
 * Поведение — `docs/brief.md` §3–5,8, раскладка — `docs/design.md` §5. Чистая
 * логика без DOM/Vue: навигация, выбор варианта, правило `exclusive`, поле
 * «Другое», пошаговая валидация, persist-снимок и маппинг в {@link Submission}.
 * Vue-композабл (фаза визуала, b24ui) оборачивает этот класс реактивностью
 * (`shallowRef(fill.state)`); визуальный гейт — #13.
 */

/** Ответ клиента на один вопрос в процессе прохождения (до маппинга в submission). */
export interface QuestionAnswer {
  /** Выбранные option_key. single — 0..1, multi — 0..N. */
  picked: string[]
  /** Текст варианта «Другое» (isOther). Сохраняется даже при снятии выбора (§5). */
  other: string
  /** Свободный текст для вопроса type='text'. */
  text: string
}

/** Состояние прохождения: текущий вопрос, ответы, флаг показа ошибки шага. */
export interface SurveyFillState {
  current: number
  answers: Record<string, QuestionAnswer>
  /** Показать ошибку валидации текущего вопроса (ставится при блокировке «Далее»). */
  showError: boolean
}

/**
 * Схема снимка для persist. Используется и как граница доверия при restore из
 * localStorage (юзер может подменить): {@link SurveyFill} прогоняет вход через
 * `safeParse` — границы (picked/other/text) отсекают раздувание payload, кривой
 * снимок целиком отбрасывается (старт с нуля). Лимиты щедрее UI (UI режет жёстче).
 */
export const surveyFillSnapshotSchema = z.object({
  surveyKey: z.string().min(1).max(200),
  versionNo: z.number().int().positive(),
  current: z.number().int().min(0),
  answers: z.record(
    z.string().max(200),
    z.object({
      picked: z.array(z.string().max(200)).max(200),
      other: z.string().max(2000),
      text: z.string().max(4000)
    })
  )
})
export type SurveyFillSnapshot = z.infer<typeof surveyFillSnapshotSchema>

function emptyAnswer(): QuestionAnswer {
  return { picked: [], other: '', text: '' }
}

/** Копия ответа (массив picked тоже): защита state от мутаций через ссылку наружу. */
function cloneAnswer(a: QuestionAnswer): QuestionAnswer {
  return { picked: [...a.picked], other: a.other, text: a.text }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** single — замена выбора (ровно один вариант). */
function selectSingle(optionKey: string): string[] {
  return [optionKey]
}

/** multi — тоггл + правило exclusive (§4): исключающий снимает прочие и наоборот. */
function toggleMulti(question: Question, picked: string[], optionKey: string): string[] {
  if (picked.includes(optionKey)) return picked.filter((k) => k !== optionKey) // снятие — просто убрать
  const opt = question.options.find((o) => o.key === optionKey)
  if (opt?.isExclusive) return [optionKey] // выбор исключающего — оставить только его
  const exclusiveKeys = new Set(question.options.filter((o) => o.isExclusive).map((o) => o.key))
  return [...picked.filter((k) => !exclusiveKeys.has(k)), optionKey] // обычный — снять исключающий, добавить
}

/** «Отвечен ли вопрос»: text — непустой trim; single/multi — есть выбор. */
export function isAnswered(question: Question, answer: QuestionAnswer): boolean {
  return question.type === 'text' ? answer.text.trim().length > 0 : answer.picked.length > 0
}

/**
 * Маппинг ответа на один вопрос в RawAnswer (§5,§8) или `undefined` (пропустить):
 * - text: `{ text }` при непустом trim, иначе пропуск;
 * - single/multi: `{ values }` в КАНОНИЧЕСКОМ порядке опций (детерминизм), пусто → пропуск;
 * - текст «Другое» уходит в `text`, только если вариант isOther выбран И текст непустой.
 */
function buildRawAnswer(question: Question, answer: QuestionAnswer): RawAnswer | undefined {
  if (question.type === 'text') {
    const t = answer.text.trim()
    return t ? { text: t } : undefined
  }
  if (answer.picked.length === 0) return undefined
  const order = new Map(question.options.map((o, i) => [o.key, i]))
  const values = [...answer.picked].sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)
  )
  const raw: RawAnswer = { values }
  const otherKey = question.options.find((o) => o.isOther)?.key
  if (otherKey && answer.picked.includes(otherKey)) {
    const t = answer.other.trim()
    if (t) raw.text = t
  }
  return raw
}

export class SurveyFill {
  private readonly version: CompiledVersion
  private _state: SurveyFillState

  constructor(version: CompiledVersion, restored?: SurveyFillSnapshot) {
    if (version.questions.length === 0) throw new Error('SurveyFill: версия без вопросов')
    this.version = version
    this._state = SurveyFill.initState(version, restored)
  }

  private static initState(version: CompiledVersion, restored?: unknown): SurveyFillState {
    const answers: Record<string, QuestionAnswer> = {}
    for (const q of version.questions) answers[q.key] = emptyAnswer()
    // restored из недоверенного хранилища — валидируем на границе; кривой снимок отбрасываем.
    const snap = restored === undefined ? undefined : surveyFillSnapshotSchema.safeParse(restored)
    if (snap?.success && snap.data.surveyKey === version.surveyKey && snap.data.versionNo === version.versionNo) {
      const data = snap.data
      for (const q of version.questions) {
        // Object.hasOwn — не проваливаемся в прототип при патологичном ключе (напр. "__proto__").
        const a = Object.hasOwn(data.answers, q.key) ? data.answers[q.key] : undefined
        if (a) answers[q.key] = { picked: [...a.picked], other: a.other, text: a.text }
      }
      return { current: clamp(data.current, 0, version.questions.length - 1), answers, showError: false }
    }
    return { current: 0, answers, showError: false }
  }

  get state(): SurveyFillState {
    return this._state
  }

  get total(): number {
    return this.version.questions.length
  }

  get currentQuestion(): Question {
    const q = this.version.questions[this._state.current]
    // current инвариантно в [0, total-1] (constructor guard + clamp в next/back/goTo).
    if (!q) throw new Error('SurveyFill: current вне диапазона вопросов')
    return q
  }

  /** Копия ответа текущего вопроса (мутация наружу не бьёт по внутреннему state). */
  get currentAnswer(): QuestionAnswer {
    return cloneAnswer(this._state.answers[this.currentQuestion.key]!) // ключ есть — initState заполнил все
  }

  /** Имя блока текущего вопроса (для рейла/хедера), либо undefined. */
  get currentBlock(): string | undefined {
    return this.currentQuestion.block
  }

  get isFirst(): boolean {
    return this._state.current === 0
  }

  get isLast(): boolean {
    return this._state.current === this.total - 1
  }

  /** 1-индексированный прогресс для UI. */
  get progress(): { current: number; total: number } {
    return { current: this._state.current + 1, total: this.total }
  }

  /** Можно ли уйти с текущего вопроса: необязательный — всегда; иначе — отвечен. */
  get canAdvance(): boolean {
    const q = this.currentQuestion
    return q.required === false || isAnswered(q, this.currentAnswer)
  }

  /** Цифровая клавиша 1..9 → option_key (индекс n-1) текущего вопроса, если есть. */
  optionKeyByNumber(n: number): string | undefined {
    if (n < 1 || n > 9) return undefined
    return this.currentQuestion.options[n - 1]?.key
  }

  /** Выбор/тоггл варианта: single — замена, multi — тоггл + exclusive. text — no-op. */
  selectOption(optionKey: string): void {
    const q = this.currentQuestion
    if (q.type === 'text') return // у text-вопроса нет вариантов
    const picked =
      q.type === 'single' ? selectSingle(optionKey) : toggleMulti(q, this._state.answers[q.key]!.picked, optionKey)
    this.patchAnswer(q.key, { picked })
    this.clearError()
  }

  /** Текст поля «Другое» (не влияет на валидность шага — §5). */
  setOther(text: string): void {
    this.patchAnswer(this.currentQuestion.key, { other: text })
  }

  /** Значение вопроса type='text'. */
  setText(text: string): void {
    this.patchAnswer(this.currentQuestion.key, { text })
    this.clearError()
  }

  /**
   * «Далее»/«Отправить». Невалидный шаг — ставит showError, возвращает false
   * (остаёмся). Валидный — продвигает (кроме последнего) и возвращает true; на
   * последнем true означает «можно отправлять». Необязательный вопрос валиден всегда.
   */
  next(): boolean {
    if (!this.canAdvance) {
      this._state = { ...this._state, showError: true }
      return false
    }
    if (!this.isLast) {
      this._state = { ...this._state, current: this._state.current + 1, showError: false }
    }
    return true
  }

  /** «Назад» (без эффекта на первом вопросе). */
  back(): void {
    if (this.isFirst) return
    this._state = { ...this._state, current: this._state.current - 1, showError: false }
  }

  /**
   * Прыжок на вопрос по 0-based индексу (deep-link `?q=N` → `goTo(N-1)`); индекс
   * клампится в [0, total-1]. Линейную полноту required НЕ навязывает — это забота
   * пошагового флоу (next) и Vue-обёртки; сервер валидирует структуру, не полноту.
   */
  goTo(index: number): void {
    this._state = { ...this._state, current: clamp(index, 0, this.total - 1), showError: false }
  }

  /** Снимок для persist (localStorage) — с глубокой копией (без общих ссылок на state). */
  snapshot(): SurveyFillSnapshot {
    const answers: Record<string, QuestionAnswer> = {}
    for (const [k, a] of Object.entries(this._state.answers)) answers[k] = cloneAnswer(a)
    return {
      surveyKey: this.version.surveyKey,
      versionNo: this.version.versionNo,
      current: this._state.current,
      answers
    }
  }

  /** Маппинг в Submission: пропускает пустые/необязательные, канонический порядок values. */
  toSubmission(): Submission {
    const answers: Record<string, RawAnswer> = {}
    for (const q of this.version.questions) {
      const raw = buildRawAnswer(q, this._state.answers[q.key]!)
      if (raw) answers[q.key] = raw
    }
    return { surveyKey: this.version.surveyKey, versionNo: this.version.versionNo, answers }
  }

  private patchAnswer(key: string, patch: Partial<QuestionAnswer>): void {
    const prev = this._state.answers[key]!
    this._state = { ...this._state, answers: { ...this._state.answers, [key]: { ...prev, ...patch } } }
  }

  private clearError(): void {
    if (this._state.showError) this._state = { ...this._state, showError: false }
  }
}
