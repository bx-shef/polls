import { QUESTION_TYPES, METRICS } from '../domain/schema'

/**
 * Framework-agnostic логика КОНСТРУКТОРА опроса (админ-UI, фаза 5). Чистые функции без DOM/Vue:
 * генерация стабильных ключей, добавление/удаление/перестановка вопросов и опций, структурная
 * валидация и нормализация черновика к публикации. Vue-страница (`app/pages/admin/surveys/[key].vue`)
 * держит реактивное состояние и зовёт эти функции (мутируют переданные массивы — Vue-реактивность
 * отслеживает). Под юнит-тестами (детерминизм, граничные индексы). Серверная авторитетная валидация —
 * `surveyDraftSchema` + `compile()`; здесь — лишь грубые правила, чтобы не слать заведомо битый черновик.
 */

/**
 * Опция в редакторе. Структурно совместима с domain `Option`, но НЕ реэкспортируем доменный тип:
 * редактор — упрощённая проекция (без `isOther`/`isExclusive`, read-only при рендере). score nullable.
 */
export interface EditorOption {
  key: string
  label: string
  score?: number | null
}

/**
 * Вопрос в редакторе. `type`/`metric` — НАМЕРЕННО широкие `string` (а не доменные union'ы): редактор
 * терпим к любому значению из селекта, авторитетная проверка — на сервере (`compile()`). Для проверок
 * «тип с выбором» используем {@link CHOICE_TYPES}, а не хардкод строк.
 */
export interface EditorQuestion {
  key: string
  type: string
  metric: string
  required: boolean
  text: string
  options: EditorOption[]
}

/** Канонические перечни из ядра — UI строит из них списки (новый тип/метрика появится сам). */
export const TYPE_VALUES = QUESTION_TYPES
export const METRIC_VALUES = METRICS

/** Типы вопросов с вариантами ответа (нужны опции). Единый источник для UI и валидации. */
export const CHOICE_TYPES: ReadonlySet<string> = new Set(['single', 'multi'])

/** Все занятые ключи (вопросы + их опции) — база для генерации новых без коллизий. */
export function collectKeys(questions: readonly EditorQuestion[]): Set<string> {
  const s = new Set<string>()
  for (const q of questions) {
    s.add(q.key)
    for (const o of q.options) s.add(o.key)
  }
  return s
}

/**
 * Уникальный человекочитаемый ключ `prefix_N` (N — наименьший свободный), стабильный якорь
 * сопоставимости версий. Детерминирован относительно `taken` (тестируемо, без Date.now).
 */
export function uniqueKey(prefix: string, taken: ReadonlySet<string>): string {
  let n = 1
  let k = `${prefix}_${n}`
  while (taken.has(k)) {
    n++
    k = `${prefix}_${n}`
  }
  return k
}

/** Добавляет новый вопрос (тип single, метрика choice, обязательный, без опций) в конец. */
export function addQuestion(questions: EditorQuestion[]): void {
  questions.push({
    key: uniqueKey('q', collectKeys(questions)),
    type: 'single',
    metric: 'choice',
    required: true,
    text: '',
    options: []
  })
}

/** Добавляет пустую опцию (label '', score null) к вопросу с индексом `qi`; при неверном индексе — no-op. */
export function addOption(questions: EditorQuestion[], qi: number): void {
  const q = questions[qi]
  if (!q) return
  q.options.push({ key: uniqueKey('o', collectKeys(questions)), label: '', score: null })
}

/** Перемещает элемент массива на одну позицию (dir −1 вверх / +1 вниз); на краях — no-op. */
export function moveItem<T>(arr: T[], index: number, dir: -1 | 1): void {
  const j = index + dir
  if (index < 0 || index >= arr.length || j < 0 || j >= arr.length) return
  ;[arr[index], arr[j]] = [arr[j]!, arr[index]!]
}

/**
 * Грубые структурные ошибки черновика (блокируют публикацию на клиенте с подсказкой):
 * нет вопросов / вопрос с выбором без опций. Остальное (дубль ключей, длины) ловит сервер.
 */
export function structureErrors(questions: readonly EditorQuestion[]): string[] {
  const errs: string[] = []
  if (!questions.length) errs.push('Добавьте хотя бы один вопрос.')
  questions.forEach((q, i) => {
    if (CHOICE_TYPES.has(q.type) && q.options.length === 0) {
      errs.push(`Вопрос ${i + 1}: для типа с выбором нужна хотя бы одна опция.`)
    }
  })
  return errs
}

/**
 * Нормализует вопросы к публикации: у текстовых опции не нужны (чистим, даже если остались от
 * смены типа); `score: null` → `undefined` (опциональное поле, не шлём «пусто» как значение).
 */
export function normalizeForPublish(questions: readonly EditorQuestion[]): EditorQuestion[] {
  return questions.map((q) => ({
    ...q,
    options: q.type === 'text' ? [] : q.options.map((o) => ({ ...o, score: o.score ?? undefined }))
  }))
}
