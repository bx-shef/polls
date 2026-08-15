import { SurveyFill, surveyFillSnapshotSchema } from '~core/client/survey-fill'
import { decideInvitationToken, parseStoredInvitation, type StoredInvitation } from '~core/client/invitation-link'
import { serverMessage } from '~core/client/server-message'
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
 * docs/project-map.md (почему обёртка, а не реактивный объект внутри ядра).
 *
 * Загрузку версии делает СТРАНИЦА через `useAsyncData` (SSR-payload + дедуп + рефетч при
 * смене `:key`); сюда версия/ошибка приходят через `reset()`.
 *
 * Persist (#34): прогресс кладётся в localStorage (`snapshot()`), `hydrate()` на клиенте
 * восстанавливает его (resume на reload) и поддерживает deep-link `?q=N`. Только клиент
 * (localStorage нет на SSR), restore — в `onMounted` страницы (без hydration-mismatch).
 * Снимок недоверенный → `SurveyFill` валидирует его на границе (safeParse + сверка версии).
 */
/**
 * `link-invalid` — отдельная фаза, а не разновидность `error`. Разница для человека принципиальная:
 * при `error` опрос не открылся (можно обновить страницу), а здесь опрос жив, но именно ЭТА ссылка
 * больше не годится, и обновление ничего не изменит. Показывается ДО заполнения — иначе человек
 * узнаёт об этом на «Отправить», когда работа уже сделана.
 */
export type SurveyPhase = 'loading' | 'error' | 'link-invalid' | 'intro' | 'survey' | 'thanks'

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

  /**
   * Токен приглашения из ссылки. Держим отдельным ref, а не в `SurveyFill`: заполнение опроса о
   * приглашении ничего не знает, и подмешивать туда транспортную деталь значило бы менять схему
   * снимка, которую валидирует ядро.
   */
  const invitationToken = ref<string | undefined>(undefined)

  // Гард пустого ключа: без surveyKey не трогаем localStorage (иначе мина "survey:" на всех опросах).
  const persistKey = () => {
    const k = version.value?.surveyKey
    return k ? `survey:${k}` : null
  }
  /**
   * Токен хранится ПОД ОТДЕЛЬНЫМ ключом, а не внутри снимка заполнения. Иначе пришлось бы менять
   * схему снимка в ядре ради транспортной детали, а старые снимки переставали бы разбираться.
   */
  const tokenKey = () => {
    const k = persistKey()
    return k ? `${k}:token` : null
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
    const tKey = tokenKey()
    if (!import.meta.client || !key) return
    try {
      localStorage.removeItem(key)
      if (tKey) localStorage.removeItem(tKey)
    } catch { /* ignore */ }
  }

  function readStoredToken(): StoredInvitation | undefined {
    const key = tokenKey()
    if (!import.meta.client || !key) return undefined
    try {
      const raw = localStorage.getItem(key)
      return raw ? parseStoredInvitation(JSON.parse(raw)) : undefined
    } catch { return undefined }
  }
  /** Запись пересохраняется целиком — `savedAt` и есть отсчёт TTL от последнего визита по ссылке. */
  function saveToken(token: string): void {
    const key = tokenKey()
    if (!import.meta.client || !key) return
    try {
      localStorage.setItem(key, JSON.stringify({ token, savedAt: Date.now() } satisfies StoredInvitation))
    } catch { /* приватный режим/квота — persist необязателен */ }
  }
  function hasDraft(): boolean {
    const key = persistKey()
    if (!import.meta.client || !key) return false
    try { return localStorage.getItem(key) !== null } catch { return false }
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
      // Сервер на 404 объясняет и что делать («ссылка устарела — попросите новую»); свой текст
      // нужен, только когда ответа не было вовсе.
      errorMsg.value = serverMessage(fetchError)
        ?? 'Не удалось открыть опрос. Проверьте подключение и обновите страницу.'
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
  function hydrate(deepLinkIndex?: number, token?: string) {
    if (phase.value !== 'intro' || !version.value) return
    // Порядок обязателен: сперва решение о токене, и только потом чтение черновика — решение
    // вправе его стереть (чужое приглашение / протухшая привязка), а прочитанный до того снимок
    // пережил бы удаление в переменной и восстановился бы как ни в чём не бывало.
    const kept = applyToken(token)
    const snap = kept ? readSnapshot() : undefined
    if (snap !== undefined) {
      // Resume важнее deep-link: у вернувшегося пользователя сохранённая позиция приоритетнее
      // ?q из ссылки (не теряем прогресс, не создаём гибрид). current берётся из снимка (initState).
      startFill(snap)
      return
    }
    if (deepLinkIndex !== undefined) startFill(undefined, deepLinkIndex)
    // иначе — остаёмся на интро (свежий старт по кнопке)
  }

  /**
   * Применить правило старшинства токена (само правило — чистое, в `~core/client`).
   *
   * Возвращает, ПЕРЕЖИЛ ли сохранённый черновик эту сверку: `false` — его только что стёрли, и
   * восстанавливать из него нечего.
   */
  function applyToken(token?: string): boolean {
    const d = decideInvitationToken({
      urlToken: token,
      stored: readStoredToken(),
      hasDraft: hasDraft(),
      nowMs: Date.now()
    })
    // Порядок: сначала сброс (он уносит и черновик, и запись о токене), потом запись нового.
    if (d.clearDraft) clearSnapshot()
    invitationToken.value = d.token
    if (d.save && d.token) saveToken(d.token)
    return !d.clearDraft
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
          answers: sub.answers,
          // Токен приглашения — то, чем ответ привязывается к сделке. Без него сервер примет ответ,
          // но запишет с пустым контекстом: аналитика по услуге/клиенту/ответственному потеряется
          // МОЛЧА. Отсюда же и `invitationToken` в записи — durable-якорь идемпотентности.
          ...(invitationToken.value ? { invitation: invitationToken.value } : {})
        }
      })
      clearSnapshot() // опрос завершён — прогресс больше не восстанавливаем
      phase.value = 'thanks'
    } catch (e) {
      // Остаёмся на опросе, показываем ошибку отправки. Снимок НЕ чистим — намеренно: повтор
      // не теряет ответы (nonce одноразов, повтор берёт новый через /api/session). Это верно и
      // для «терминальных» отказов (409/403): ответы респондента остаются при нём, а не пропадают
      // вместе с сообщением.
      errorMsg.value = serverMessage(e)
        ?? 'Не удалось отправить ответы. Проверьте подключение и попробуйте ещё раз.'
    } finally {
      submitting.value = false
    }
  }

  /**
   * Ссылка негодна — показать это ВМЕСТО опроса. Зовёт страница по ответу предпросмотра.
   * Черновик при этом не трогаем: ссылка мертва, а ответы человека — нет, и они могут пригодиться,
   * если менеджер выпишет новую ссылку на тот же опрос.
   */
  function rejectLink(message: string) {
    errorMsg.value = message
    phase.value = 'link-invalid'
    bump()
  }

  // ⚠️ `invitationToken` наружу НЕ отдаём. Он внутренний: страница знает свой токен из адресной
  // строки, а здешний — эффективный (может отличаться, если в адресе токена нет). Одно имя на две
  // разные величины уже путало на ревью, а потребителей у экспорта не было ни одного.
  return {
    version, phase, errorMsg, submitting, view,
    reset, start, hydrate, rejectLink, selectOption, setOther, setText, back, next, submit
  }
}
