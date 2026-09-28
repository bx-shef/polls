<script setup lang="ts">
import CircleCheckIcon from '@bitrix24/b24icons-vue/outline/CircleCheckIcon'
import CopyIcon from '@bitrix24/b24icons-vue/outline/CopyIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { DEAL_TAB_TITLE, TEMPLATE_SP_TITLE, TEMPLATE_TAB_TITLE } from '#shared/portal-names'
import { formatScore } from '#shared/score-format'
import type { SurveyChoice } from '#shared/survey-choice'
import { copyToClipboard } from '~/utils/clipboard'
import { framePass } from '~/utils/frame-auth'
import { isPreview, portalGate } from '~/utils/in-portal'
import { dealIdFrom } from '~/utils/placement'

/**
 * The app's tab inside a deal card: pick a survey, issue a link, copy it.
 *
 * Живёт внутри iframe портала, поэтому здесь ТОЛЬКО компоненты `b24ui` — правило проекта.
 * Публичная страница анкеты устроена наоборот и своей вёрсткой: она вне портала.
 *
 * ⚠ Страница НЕ ходит в портал за данными сама, хотя из фрейма это возможно. Выпуск ссылки —
 * это три шага, которые должны случиться в одном порядке и с записью в нашу базу (кэш схемы,
 * элемент смарт-процесса, хеш токена). Половина из них браузеру недоступна, а разорвать их
 * между браузером и сервером значит получить ссылку, ведущую в никуда, при первом же обрыве связи.
 * Поэтому наружу уходит только пропуск — `member_id` и фреймовый токен, — а работает сервер.
 */

/** A published survey as the server sends it: what to choose by, without the schema itself. */
type Survey = SurveyChoice

/** Выпущенная ссылка, как её отдаёт сервер: состояние уже посчитано там. */
interface IssuedLink {
  itemId: number
  /** Заголовок элемента «Опроса» — «анкета — сделка». Во вкладке не показывается: см. `surveyTitle`. */
  title: string
  code: string
  version: number
  state: 'active' | 'completed' | 'revoked' | 'expired'
  expiresAt: string
  completedAt: string
  score: number | null
}

/**
 * Подписи состояний. Словами, а не кодом: вкладку читает менеджер, а не разработчик.
 *
 * ⚠ «Отозвана» и «Истекла» разведены намеренно. Обе означают «не откроется», но первая —
 * это действие человека, а вторая — течение времени, и при разборе «почему клиент не ответил»
 * разница между ними и есть весь ответ.
 */
// ⚠ `as const satisfies`, а не аннотация типом: `color` должен остаться литералом, иначе
// `B24Badge` не примет строку — у него цвет это перечисление ролей, а не любой текст.
// Правило проекта «цвет задаётся именем роли» здесь проверяется компилятором.
const STATES = {
  active: { label: 'Ждём ответа', color: 'air-primary' },
  completed: { label: 'Пройдена', color: 'air-primary-success' },
  revoked: { label: 'Отозвана', color: 'air-secondary' },
  expired: { label: 'Истекла', color: 'air-secondary' },
} as const satisfies Record<IssuedLink['state'], { label: string, color: string }>

/**
 * Отказы выпуска, у каждого свой текст.
 *
 * «Попробуйте ещё раз» на отказ в доступе — обман: сколько ни пробуй, чужую сделку не увидишь.
 * Человек должен понимать, что именно случилось, иначе он будет звонить в поддержку.
 *
 * ⚠ «Обновите страницу» здесь больше нет (issue #84, п. 1): одну вкладку внутри карточки портала
 * обновить нельзя — только закрыть сделку и открыть заново. Совет, который нечем выполнить, заменён
 * кнопкой «Обновить» рядом с текстом: её прикладывает `refusalStale`.
 */
const REFUSALS: Record<string, string> = {
  'survey-gone': 'Этот опрос сняли с публикации, пока вкладка была открыта. Обновите список и выберите другую анкету.',
  'deal-denied': 'У вас нет доступа к этой сделке — ссылку по ней выпустить нельзя.',
  'not-provisioned': 'Приложение ещё настраивается: смарт-процессы опросов на портале не найдены.',
}

/**
 * Отказы, после которых вкладка знает, что её списки устарели: к тексту прилагается «Обновить».
 * `lists-stale` — не ответ сервера, а своя пометка сорвавшейся перечитки.
 */
const STALE_REFUSALS = new Set(['survey-gone', 'lists-stale'])

/**
 * The lists did not arrive when the tab opened. The advice is the «Обновить» button in the same box.
 *
 * ⚠ Повторный отказ говорит о себе иначе — временем попытки. Иначе нажатие «Обновить», снова
 * не удавшееся, оставляло плашку слово в слово прежней, и «повторил, и не вышло» было неотличимо
 * от «кнопка не сработала» — та самая немая кнопка, от которой вкладка лечится. Нашли `/review`
 * и `/code-review` в PR #89.
 */
function loadFailure(again: boolean): string {
  const when = again ? ` Последняя попытка — в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.` : ''
  return `Не удалось получить список опросов с портала.${when} Нажмите «Обновить», чтобы попробовать ещё раз.`
}

/** Перечитка сорвалась, а прежние списки на экране есть: они остаются, и сказано, что могли устареть. */
const REFRESH_FAILURE = 'Не удалось перечитать списки с портала — на экране они могут быть устаревшими. Попробуйте обновить ещё раз.'

/**
 * Список выпущенных ссылок не пришёл при открытии вкладки, а анкеты пришли.
 *
 * ⚠ Отдельным текстом, а не «могут быть устаревшими»: списка на экране нет вовсе, и пустое место
 * читается как «по сделке ничего не выпускали». Ровно так и появляется вторая живая ссылка — дубль,
 * ради которого список заводился. Поэтому совет — обновить ПРЕЖДЕ, чем выпускать.
 */
const LINKS_FAILURE = 'Не удалось получить с портала список уже выпущенных ссылок — по этой сделке их могли выпускать. Нажмите «Обновить», прежде чем выпускать новую.'

const PLURAL = new Intl.PluralRules('ru-RU')

/**
 * Неразрывный пробел — кодом символа, а не самим символом: в исходнике он неотличим от обычного,
 * и следующая правка заменила бы его пробелом молча (линтер такие символы вдобавок не пропускает).
 */
const NBSP = String.fromCharCode(0xA0)

/**
 * A number with its word in the right form: «1 раздел», «3 раздела», «5 разделов».
 *
 * Между числом и словом — неразрывный пробел: строка переносится по « · », а не между «3» и «раздела».
 */
function counted(value: number, one: string, few: string, many: string): string {
  const form = PLURAL.select(value)
  return `${value}${NBSP}${form === 'one' ? one : form === 'few' ? few : many}`
}

/** The survey's key in the picker. Code and version together: two versions can be published at once. */
function surveyKey(survey: { code: string, version: number }): string {
  return `${survey.code}:${survey.version}`
}

definePageMeta({ layout: 'portal' })

const route = useRoute()

const loading = ref(true)
/**
 * Гейт присутствия в портале — общий с `/app` и `/install` (issue #29).
 *
 * ⚠ Здесь была своя обработка «фрейма нет»: «Не удалось связаться с порталом. Обновите
 * страницу». Снаружи портала это совет, который не может сработать: страница открыта
 * не оттуда, а не потому, что портал молчит. Вкладка сделки попадает наружу реже своих
 * соседей — её адрес знает только портал, — но ровно поэтому её и забыли бы перевести.
 */
const resolved = ref(false)
const inPortal = ref(false)
/** Вкладка не получила списков — показать ей нечего, и отказ встаёт ВМЕСТО содержимого. */
const failure = ref('')
const notProvisioned = ref(false)
const surveys = ref<Survey[]>([])
const dealId = ref<number | null>(null)
const links = ref<IssuedLink[]>([])

/**
 * Отказ последнего действия — выпуска, отзыва, перевыпуска. Пусто — отказа нет.
 *
 * ⚠ Отдельно от `failure`, и это решение (issue #84): раньше отказ действия тоже вставал ВМЕСТО
 * всего содержимого. Текст «выберите другую анкету» показывался на экране, где выбирать было
 * уже не из чего, а вернуть список можно было, только переоткрыв сделку. Отказ действия списков
 * не отменяет — он встаёт над ними.
 */
const refusal = ref('')
/** Отказ говорит, что списки вкладки устарели: рядом с текстом стоит «Обновить». */
const refusalStale = ref(false)
/**
 * Где показать отказ: над списком ссылок (`top`) или у кнопки выпуска (`picker`).
 *
 * ⚠ У КНОПКИ, которую нажимали, а не в одном месте на всё. Под сеткой из дюжины перенесённых
 * анкет кнопка «Выпустить ссылку» стоит на экран ниже списка, и плашка отказа над списком
 * оказывалась за верхом вкладки: нажатие выглядело бы так, будто не случилось ничего, — ровно
 * та немая кнопка, от которой эта вкладка лечится. Место задаёт действие, с которого всё началось:
 * перевыпуск нажимают в строке списка, и его отказ — над списком, даже когда отказал выпуск.
 */
const refusalNear = ref<'top' | 'picker'>('top')

/**
 * Выбранная анкета — ключ `код:версия`; пусто — не выбрана.
 *
 * ⚠ ВЫБОР И ВЫПУСК — ДВА ШАГА, и это решение, а не лишний щелчок (issue #84, п. 2). Раньше каждая
 * анкета была кнопкой, и случайное нажатие СРАЗУ выпускало ссылку, а каждый выпуск — это элемент
 * «Опроса» в CRM клиента и живой одноразовый токен. Отменить такое нажатие нечем: отзыв гасит
 * ссылку, но элемент в CRM остаётся. Карточка только выбирает; выпускает одна кнопка, и она
 * неактивна, пока ничего не выбрано.
 */
const selected = ref('')

/** Published surveys by `code:version` — the one lookup the picker, the list and «Перевыпустить» share. */
const surveyByKey = computed(() => new Map(surveys.value.map(survey => [surveyKey(survey), survey])))
const selectedSurvey = computed(() => surveyByKey.value.get(selected.value))

/**
 * Только что выпущенная ссылка.
 *
 * ⚠ Смахнуть её с экрана дорого. У нас лежит только хеш токена, а в CRM адрес пишется последним
 * шагом выпуска и не всегда: запись может не пройти, а на порталах, обустроенных до #87, поле
 * «Ссылка на анкету» пока не стоит в карточке. Здесь — самое удобное место его скопировать.
 * Прежний текст «токен показывается ОДИН раз» стал неправдой с #87; нашёл `/review` в PR #89.
 */
const issued = ref<{ url: string, expiresAt: string, title: string } | null>(null)
const copied = ref(false)
/** Скопировать не вышло ни одним путём: адрес выделен, и человеку сказано, что делать дальше. */
const copyFailed = ref(false)
/** Имя кнопки копирования — для подсказки и экранного диктора: сама кнопка — значок. */
const copyLabel = computed(() => copied.value ? 'Скопировано' : 'Скопировать ссылку')
/**
 * Что вышло с копированием — строкой под полем.
 *
 * ⚠ Строка стоит в разметке ВСЕГДА, меняется только текст. Живую область (`role="status"`),
 * появившуюся уже с текстом, экранные дикторы часто не зачитывают, а кнопка — только значок:
 * человек с диктором не узнал бы, скопировалось ли. Нашли `/review` и `/code-review` в PR #89.
 *
 * ⚠ «Ctrl+C» не единственный совет: в мобильном клиенте Битрикс24 клавиатуры с Ctrl нет.
 */
const copyStatus = computed(() => {
  if (copied.value) return 'Скопировано — вставьте ссылку в письмо или сообщение клиенту.'
  if (copyFailed.value) return 'Браузер не дал скопировать сам. Адрес выделен — скопируйте его: Ctrl+C (на Mac — Cmd+C) или долгим нажатием на телефоне.'
  return ''
})
const urlInput = useTemplateRef('urlInput')

const issuing = ref(false)
/** Строка списка, по которой идёт отзыв: номер элемента; ноль — ни одна. */
const busyItem = ref(0)
/** Строка, по которой идёт перевыпуск целиком — от отзыва до новой ссылки. */
const reissuing = ref(0)
const refreshing = ref(false)

/**
 * Идёт ли обращение, после которого списки станут другими.
 *
 * ⚠ Пока оно идёт, остальные действия погашены. Иначе перечитка, начатая раньше выпуска, могла бы
 * вернуться позже него и показать список без только что выпущенной ссылки — правдоподобно и неверно.
 */
const busy = computed(() => issuing.value || busyItem.value !== 0 || reissuing.value !== 0 || refreshing.value)

const gate = computed(() => portalGate({
  resolved: resolved.value,
  inPortal: inPortal.value,
  preview: isPreview(route.query.preview),
}))

/**
 * Можно ли перечитать списки. Без связи с порталом перечитывать нечем, а без сделки — незачем:
 * сделку назначает портал при открытии вкладки, и перечитка её не найдёт.
 */
const canRefresh = computed(() => inPortal.value && !loading.value && dealId.value !== null)

/**
 * Связь с порталом. `undefined` ровно до конца `onMounted`.
 *
 * Дальше в коде стоит `frame!`, и это не «а вдруг пронесёт»: обе функции, которые его читают,
 * достижимы только из шаблона, а шаблон до конца `onMounted` показывает скелет — `loading`
 * снимается в `finally`, то есть после присваивания. Если `initializeB24Frame` упал, кнопок
 * нет вовсе: на экране карточка отказа. Убрать `finally` или отрисовать кнопки при `loading` —
 * и это перестанет быть правдой; поэтому здесь и написано, чем именно держится.
 */
let frame: B24Frame | undefined

// Имя вкладки — то же, под которым её регистрирует сервер (`shared/portal-names.ts`): человек
// ищет в карточке сделки вкладку под этим именем, и разойтись им нельзя.
useHead({ title: DEAL_TAB_TITLE })

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
    dealId.value = dealIdFrom(frame.placement.options, route.query)
    const read = await readLists()
    if (!read.surveys) failure.value = loadFailure(false)
    else if (!read.links) refuse('lists-stale', LINKS_FAILURE, 'top')
  }
  finally {
    loading.value = false
  }
})

/**
 * Пропуск, который сервер проверит у портала: сами по себе эти два значения ничего не дают.
 *
 * ⚠ Имена полей читает `readFramePass`, а не этот файл. Здесь стояло `auth.memberId` —
 * а SDK отдаёт `member_id`, и из-за индексной сигнатуры `[key: string]: any` в его типе
 * это компилировалось молча. На сервер уезжало `memberId: undefined`, то есть вкладка
 * не работала бы ни разу при полностью зелёном `pnpm check`.
 */
async function pass() {
  // Токен фрейма живёт час: `framePass` продлевает его у портала сам (разбор — у него).
  const parsed = await framePass(frame!.auth)
  if (parsed === null) throw new Error('нет данных авторизации фрейма')
  return { memberId: parsed.memberId, authId: parsed.authId }
}

/**
 * Reads both lists, waiting for both answers, and says which of them arrived.
 *
 * ⚠ `allSettled`, а не `all`. `Promise.all` отдавал управление на первом отказе, и перечитка
 * «заканчивалась» — кнопки снова активны, — пока второй запрос ещё шёл. Поздний ответ затирал
 * список, прочитанный уже после выпуска: ссылки, выпущенной секунду назад, в нём не было. Ровно
 * от этой гонки и гасятся кнопки на время обращений (`busy`). Нашли `/review` и `/code-review`
 * в PR #89. Оба обращения по-прежнему идут одновременно — ждать их по очереди незачем.
 */
async function readLists(): Promise<{ surveys: boolean, links: boolean }> {
  const [surveysRead, linksRead] = await Promise.allSettled([loadSurveys(), loadLinks()])
  return { surveys: surveysRead.status === 'fulfilled', links: linksRead.status === 'fulfilled' }
}

/**
 * Перечитать оба списка по кнопке «Обновить».
 *
 * ⚠ Только по нажатию, а не по таймеру (issue #84, п. 1). Каждая перечитка — это обращения
 * к порталу КЛИЕНТА, в его лимиты REST, а вкладка может висеть открытой часами: перечитка раз
 * в минуту тратила бы чужие лимиты на экран, на который никто не смотрит.
 *
 * ⚠ Только что выпущенную ссылку перечитка НЕ убирает — ни удачная, ни сорвавшаяся: почему её
 * дорого смахнуть с экрана — у `issued`. Поэтому сорвавшаяся перечитка поверх прежних списков —
 * это отказ действия над ними, а не `failure`, встающий вместо всего; `failure` остаётся только
 * у вкладки, которой показать нечего с самого открытия. Снимается он ПОСЛЕ ответа, а не до
 * запроса: сними его заранее — и на время перечитки из-под плашки выглядывала бы ветка «опросов
 * пока нет».
 */
async function refresh(): Promise<void> {
  if (frame === undefined || busy.value) return
  refreshing.value = true
  refusal.value = ''
  try {
    const read = await readLists()
    if (!read.surveys && failure.value !== '') failure.value = loadFailure(true)
    else if (read.surveys) failure.value = ''
    if (failure.value === '' && !(read.surveys && read.links)) refuse('lists-stale', REFRESH_FAILURE, 'top')
  }
  finally {
    refreshing.value = false
  }
}

async function loadSurveys() {
  const result = await $fetch<{ ok: boolean, reason?: string, surveys?: Survey[] }>(
    '/api/portal/surveys',
    { method: 'POST', body: await pass() },
  )
  // ⚠ Признак ставится заново на КАЖДОЙ перечитке, а не только поднимается: администратор мог
  // доустановить приложение, пока вкладка открыта, и «ещё настраивается» обязано уйти по «Обновить».
  notProvisioned.value = !result.ok && result.reason === 'not-provisioned'
  if (!result.ok) return
  surveys.value = result.surveys ?? []
}

/**
 * Reads the list of issued links; a failure throws and leaves the list on screen as it was.
 *
 * ⚠ Отказ загрузки списка НЕ мешает выпустить новую. Список — это память о прошлом,
 * а выпуск — работа, которую человек пришёл сделать: уронив вкладку целиком из-за первого,
 * мы отняли бы второе.
 *
 * ⚠ Сорвавшееся чтение список НЕ стирает. Прежде любой отказ — 503 «портал недоступен», 429
 * ограничителя частоты — молча ставил пустой список, и раздел «Выпущенные ссылки» исчезал:
 * менеджер решал, что по сделке ничего не выпускали, и выпускал вторую живую ссылку — ровно тот
 * дубль, ради которого список заводился. Нашли `/review` и `/code-review` в PR #89. А ответ сервера
 * «нет доступа» или «не настроено» — это правда о сделке, и тогда список честно пуст.
 */
async function loadLinks(): Promise<void> {
  if (dealId.value === null) return
  const result = await $fetch<{ ok: boolean, links?: IssuedLink[] }>(
    '/api/portal/links',
    { method: 'POST', body: { ...(await pass()), dealId: dealId.value } },
  )
  links.value = result.ok ? result.links ?? [] : []
}

/** Re-reads the issued links after an action; a failure keeps the list and says it may be stale. */
async function reloadLinks(near: 'top' | 'picker'): Promise<void> {
  try {
    await loadLinks()
  }
  catch {
    refuse('lists-stale', REFRESH_FAILURE, near)
  }
}

/**
 * Shows an action refusal where the action started: its own text by reason, otherwise the fallback.
 *
 * ⚠ Место — параметром, а не договорённостью «вызывающий выставит заранее». Прежде каждое действие
 * обязано было само выставить `refusalNear` до вызова общих `issue` и `revoke`, и новый вызов,
 * забывший это сделать, унаследовал бы место прошлого действия — вплоть до плашки у скрытого
 * выбора, то есть немого отказа. Нашёл `/review` в PR #89.
 */
function refuse(reason: string | undefined, fallback: string, near: 'top' | 'picker'): void {
  refusal.value = REFUSALS[reason ?? ''] ?? fallback
  refusalStale.value = STALE_REFUSALS.has(reason ?? '')
  refusalNear.value = near
}

/**
 * Погасить ссылку.
 *
 * ⚠ Список перечитывается С СЕРВЕРА, а не правится на месте. Состояние ссылки живёт
 * на портале, и «поправить у себя» значит показать то, чего там может не быть: отзыв мог
 * не пройти наполовину, а за время, пока вкладка открыта, ссылку могли пройти.
 */
async function revoke(link: IssuedLink) {
  // ⚠ Сама себя защищает от гонки, а не надеется на погашенные кнопки: второй вызов в том же
  // такте, до перерисовки, кнопку ещё видит активной. Перевыпуск зовёт её изнутри — он и держит
  // свой флаг, поэтому здесь проверяются флаги прочих действий, а не общий `busy`.
  if (busyItem.value !== 0 || issuing.value || refreshing.value || dealId.value === null) return
  busyItem.value = link.itemId
  refusal.value = ''

  try {
    const result = await $fetch<{ ok: boolean, reason?: string }>(
      '/api/portal/revoke',
      { method: 'POST', body: { ...(await pass()), dealId: dealId.value, itemId: link.itemId } },
    )
    if (!result.ok) refuse(result.reason, 'Не удалось отозвать ссылку. Попробуйте ещё раз.', 'top')
    await reloadLinks('top')
  }
  catch {
    refuse(undefined, 'Не удалось отозвать ссылку. Попробуйте ещё раз.', 'top')
  }
  finally {
    busyItem.value = 0
  }
}

/**
 * Перевыпустить: погасить прежнюю и выпустить новую по той же анкете.
 *
 * ⚠ Именно в этом порядке. Клиент потерял письмо — и если сначала выпустить, а потом гасить,
 * то между двумя вызовами по сделке живут ДВЕ рабочие одноразовые ссылки, и какая из них
 * «настоящая», не знает никто. Сорвись гашение — останется одна лишняя живая ссылка;
 * сорвись выпуск после гашения — не останется ни одной, но это видно сразу и чинится кнопкой.
 */
async function reissue(link: IssuedLink) {
  if (busy.value) return
  const survey = surveyByKey.value.get(surveyKey(link))
  if (survey === undefined) {
    refuse(undefined, 'Эту анкету сняли с публикации — перевыпустить по ней нельзя. Выберите другую.', 'top')
    return
  }

  reissuing.value = link.itemId
  try {
    await revoke(link)
    if (refusal.value !== '') return
    // Перевыпуск нажимают в строке списка — и отказ его выпуска тоже над списком.
    await issue(survey, 'top')
  }
  finally {
    reissuing.value = 0
  }
}

/** Issues a link for the survey; a refusal is shown `near` the control the action started from. */
async function issue(survey: Survey, near: 'top' | 'picker') {
  // Защита от гонки — своя, как у `revoke`: почему — там.
  if (issuing.value || busyItem.value !== 0 || refreshing.value || dealId.value === null) return
  issuing.value = true
  refusal.value = ''

  try {
    const result = await $fetch<{ ok: boolean, reason?: string, url?: string, expiresAt?: string }>(
      '/api/portal/issue',
      {
        method: 'POST',
        body: { ...(await pass()), dealId: dealId.value, surveyCode: survey.code, surveyVersion: survey.version },
      },
    )
    if (result.ok && result.url !== undefined) {
      issued.value = { url: result.url, expiresAt: result.expiresAt ?? '', title: survey.title }
      copied.value = false
      copyFailed.value = false
      // Следующую ссылку выбирают заново: «ещё одна» — обычно по другой анкете, а выбор,
      // оставшийся от прошлой, превратил бы привычное нажатие в лишний выпуск.
      selected.value = ''
      await reloadLinks(near)
      return
    }
    refuse(result.reason, 'Не удалось выпустить ссылку. Попробуйте ещё раз.', near)
  }
  catch {
    refuse(undefined, 'Не удалось выпустить ссылку. Попробуйте ещё раз.', near)
  }
  finally {
    issuing.value = false
  }
}

/**
 * «Обновить» inside a refusal box — the same re-read as in the header, as a button next to the text.
 *
 * Заменила совет «Обновите страницу», которому внутри карточки портала нечем следовать.
 */
const refreshAction = computed(() => ({
  icon: RefreshIcon,
  label: 'Обновить',
  loading: refreshing.value,
  disabled: busy.value,
  onClick: refresh,
}))

/** Кнопки плашки отказа действия: «Обновить», только если отказ говорит, что списки устарели. */
const refusalActions = computed(() => refusalStale.value ? [refreshAction.value] : undefined)

/** Issues a link for the chosen card — the second step of the choice. A refusal shows at this button. */
async function issueSelected(): Promise<void> {
  if (selectedSurvey.value === undefined || busy.value) return
  await issue(selectedSurvey.value, 'picker')
}

/**
 * Скопировать адрес.
 *
 * ⚠ Не вышло ни одним путём — адрес ВЫДЕЛЯЕТСЯ в поле, и человеку сказано, что нажать. Раньше
 * отказ глотался молча: кнопка «Скопировать» внутри портала не делала ничего (issue #84, п. 4).
 * Выделенный адрес — это половина работы за человека: осталось одно нажатие клавиш.
 */
async function copyLink(): Promise<void> {
  if (issued.value === null) return
  const url = issued.value.url
  const done = await copyToClipboard(url)
  // Пока копирование шло, могли выпустить следующую ссылку: итог старой к новой не относится.
  if (issued.value?.url !== url) return
  copied.value = done
  copyFailed.value = !done
  if (!done) selectAddress(url)
}

/**
 * Selects the address in its field, so the person has one step left.
 *
 * ⚠ `setSelectionRange`, а не только `select()`: в WebKit на iOS — это и мобильный клиент
 * Битрикс24 — `select()` выделения не создаёт, и обещание «адрес выделен» было бы неправдой.
 * Нашли `/review` и `/code-review` в PR #89.
 */
function selectAddress(url: string): void {
  const input = urlInput.value?.inputRef as HTMLInputElement | undefined
  if (input === undefined) return
  input.focus()
  input.select()
  input.setSelectionRange(0, url.length)
}

/** A date in words. Empty — the portal did not send it, and there is nothing to invent. */
function dateLabel(raw: string): string {
  if (raw === '') return ''
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Название анкеты в строке списка.
 *
 * ⚠ Из списка анкет, а НЕ из заголовка элемента (issue #84, п. 3). Заголовок «Опроса» — это
 * «анкета — сделка» (`buildInvitationTitle`): в списке смарт-процесса он нужен целиком, а во
 * вкладке этой же сделки название сделки повторяет то, что человек и так видит, и растягивает
 * строку. Анкеты нет среди опубликованных — снята или заменена новой версией, — тогда код: он
 * короткий и тоже её называет.
 */
function surveyTitle(link: IssuedLink): string {
  // Версию сняли, а та же анкета опубликована другой версией — её название, а не латинский код:
  // иначе после выпуска версии 3 все строки по версии 2 превращались бы в «brand». `/code-review`.
  return surveyByKey.value.get(surveyKey(link))?.title
    ?? surveys.value.find(survey => survey.code === link.code)?.title
    ?? link.code
}

/**
 * Что сказать о ссылке после названия: до какого числа действует, когда истекла, когда пройдена
 * и с каким баллом. У отозванной — ничего: когда её отозвали, портал не хранит, а срок у неё
 * уже ничего не значит.
 */
function linkNote(link: IssuedLink): string {
  if (link.state === 'completed') {
    const when = dateLabel(link.completedAt)
    return [when === '' ? '' : `пройдена ${when}`, link.score === null ? '' : `балл ${formatScore(link.score)}`]
      .filter(part => part !== '')
      .join(' · ')
  }
  const until = dateLabel(link.expiresAt)
  if (until === '') return ''
  if (link.state === 'active') return `действует до ${until}`
  if (link.state === 'expired') return `истекла ${until}`
  return ''
}

/**
 * Rows of the issued-links list: title and note computed once per row.
 *
 * Считаются один раз на перечитку, а не на каждую перерисовку: пометка форматирует даты, а щелчок
 * по карточке выбора перерисовывает всю вкладку.
 */
const linkRows = computed(() => links.value.map(link => ({ link, title: surveyTitle(link), note: linkNote(link) })))

/** Picker cards: the title and one line on what is inside — «версия 2 · 3 раздела · 8 вопросов». */
const surveyCards = computed(() => surveys.value.map(survey => ({
  value: surveyKey(survey),
  label: survey.title,
  description: [
    `версия${NBSP}${survey.version}`,
    counted(survey.sections, 'раздел', 'раздела', 'разделов'),
    counted(survey.questions, 'вопрос', 'вопроса', 'вопросов'),
  ].join(' · '),
})))

/**
 * Пояснение к только что выпущенной ссылке: по какой анкете, до какого числа и что она одноразовая.
 *
 * Дата кончается на «г.», поэтому после неё запятая, а не точка: «2026 г.. Ответить» уже было.
 */
const issuedNote = computed(() => {
  if (issued.value === null) return ''
  const until = dateLabel(issued.value.expiresAt)
  return `«${issued.value.title}»${until === '' ? '' : ` — действует до ${until}`}, ответить по ней можно один раз.`
})
</script>

<template>
  <B24DashboardPanel id="deal-tab">
    <template #header>
      <B24DashboardNavbar
        :toggle="false"
        :title="DEAL_TAB_TITLE"
      >
        <!-- ⚠ «Обновить» в шапке, а не таймер: почему — у `refresh`. -->
        <template #right>
          <B24Button
            v-if="canRefresh"
            :icon="RefreshIcon"
            aria-label="Обновить"
            color="air-tertiary"
            size="sm"
            :loading="refreshing"
            :disabled="busy"
            data-testid="refresh"
            @click="refresh"
          >
            <!-- На узком экране — одним значком: имя вкладки в шапке длинное, и подпись кнопки
                 обрезала его на полуслове (видно на скриншоте шириной 375 px). -->
            <span class="hidden sm:inline">Обновить</span>
          </B24Button>
        </template>
      </B24DashboardNavbar>
    </template>

    <template #body>
      <!--
        ⚠ Ширина содержимого ограничена (issue #84, п. 3). Вкладка в карточке сделки бывает шириной
        полторы тысячи пикселей, и строка «состояние · анкета · дата», растянутая на всю, читается
        хуже, чем та же строка в колонке: глаз теряет её конец. Слева, а не по центру — под заголовком
        вкладки, как и прочее содержимое карточки портала. `4xl`, а не `3xl`: в трёх колонках уже
        строчка «версия · разделы · вопросы» под названием анкеты переносилась на середине.
      -->
      <div class="flex max-w-4xl flex-col gap-5">
        <!-- ⚠ ПЕРВЫМ, раньше скелета: снаружи портала нет ни сделки, ни прав на неё, и любой
             другой текст здесь был бы разговором не о том. Порядок тот же, что у `/install`,
             и по той же причине — там ветка ниже скелета показывала бесконечную загрузку. -->
        <B24Alert
          v-if="gate === 'outside'"
          color="air-secondary-accent"
          title="Откройте вкладку из Битрикс24"
          :description="`Эта страница живёт внутри портала: ссылку она выпускает для конкретной сделки и без портала не знает ни сделки, ни ваших прав на неё. Откройте карточку сделки и вкладку «${DEAL_TAB_TITLE}» в ней.`"
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
          :actions="[refreshAction]"
          data-testid="failure"
        />

        <template v-else>
          <B24Alert
            v-if="refusal && refusalNear === 'top'"
            color="air-primary-alert"
            title="Не получилось"
            :description="refusal"
            :actions="refusalActions"
            data-testid="refusal"
          />

          <B24Alert
            v-if="notProvisioned"
            color="air-primary-warning"
            description="Смарт-процессы опросов на портале не найдены. Обычно это значит, что установка не завершилась — переустановите приложение или обратитесь к администратору."
          >
            <template #title>
              <span class="inline-flex items-center gap-1">
                Приложение ещё настраивается
                <HelpLink anchor="not-working" />
              </span>
            </template>
          </B24Alert>

          <B24Alert
            v-else-if="dealId === null"
            color="air-primary-warning"
            title="Сделка не определена"
            description="Откройте вкладку из карточки сделки — ссылка выпускается для конкретной сделки."
          />

          <template v-else>
            <!--
              ⚠ Список стоит ПЕРВЫМ и показывается всегда, даже когда только что выпустили новую
              и даже когда выпускать сейчас не по чему. Ради него задача и заводилась: закрыл
              вкладку — и узнать, выпускал ли ты что-нибудь по этой сделке, было нельзя.

              ⚠ ОДНА карточка со строками, а не карточка на каждую ссылку (issue #84, п. 3).
              Отдельные карточки во всю ширину, да ещё с лишним отступом поверх собственного
              отступа карточки, уводили выбор анкеты вниз с каждой выпущенной ссылкой. Отступ
              здесь один — у строк.
            -->
            <section
              v-if="links.length > 0"
              data-testid="issued-links"
            >
              <div class="mb-2 flex items-center gap-1">
                <h2 class="font-semibold">
                  Выпущенные ссылки
                </h2>
                <HelpLink
                  anchor="link-states"
                  label="Что значат состояния?"
                />
              </div>
              <B24Card :b24ui="{ body: 'p-0 sm:p-0' }">
                <!-- Список — `B24PageList`, а не свой `ul` с разделителями: в наборе он есть,
                     и разделитель у него тот же, что у остальных списков портала (`/review`, PR #89). -->
                <B24PageList
                  as="ul"
                  divide
                >
                  <li
                    v-for="{ link, title, note } in linkRows"
                    :key="link.itemId"
                    class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
                    data-testid="issued-link"
                  >
                    <B24Badge
                      :color="STATES[link.state].color"
                      :label="STATES[link.state].label"
                    />
                    <span class="font-medium">{{ title }}</span>
                    <span
                      v-if="note"
                      class="text-sm text-(--ui-color-text-secondary)"
                    >
                      {{ note }}
                    </span>
                    <div
                      v-if="link.state === 'active'"
                      class="ms-auto flex gap-2"
                    >
                      <B24Button
                        size="sm"
                        color="air-secondary-no-accent"
                        label="Отозвать"
                        :loading="busyItem === link.itemId && reissuing === 0"
                        :disabled="busy"
                        @click="revoke(link)"
                      />
                      <B24Button
                        size="sm"
                        color="air-secondary-accent"
                        label="Перевыпустить"
                        :loading="reissuing === link.itemId"
                        :disabled="busy"
                        @click="reissue(link)"
                      />
                    </div>
                  </li>
                </B24PageList>
              </B24Card>
            </section>

            <!-- ⚠ «Появляются после переноса из старого решения» здесь было правдой до конструктора.
                 Теперь анкету собирают сами, и совет обязан вести туда, где это делается. -->
            <!-- «Обновить» — кнопкой в самой плашке: на узком экране в шапке он только значок,
                 и совет «нажмите «Обновить»» без кнопки рядом было бы нечем выполнить (`/review`). -->
            <B24Alert
              v-if="surveys.length === 0"
              color="air-secondary-accent"
              data-testid="no-surveys"
              :description="`Выпускать нечего: на портале нет ни одной опубликованной анкеты. Соберите и опубликуйте её на вкладке «${TEMPLATE_TAB_TITLE}» в карточке «${TEMPLATE_SP_TITLE}», а потом нажмите «Обновить».`"
              :actions="canRefresh ? [refreshAction] : undefined"
            >
              <template #title>
                <span class="inline-flex items-center gap-1">
                  Опросов пока нет
                  <HelpLink
                    anchor="edit-survey"
                    label="Как собрать анкету?"
                  />
                </span>
              </template>
            </B24Alert>

            <section
              v-else-if="issued === null"
              data-testid="picker"
            >
              <div class="mb-1 flex items-center gap-1">
                <h2
                  id="new-link-heading"
                  class="font-semibold"
                >
                  Новая ссылка
                </h2>
                <HelpLink
                  anchor="send-survey"
                  label="Как это работает?"
                />
              </div>
              <p class="mb-3 text-sm text-(--ui-color-text-secondary)">
                Выберите анкету и нажмите «Выпустить ссылку». Ссылка выпустится для этой сделки
                и будет действовать 30 дней.
              </p>
              <!-- Категорий у шаблонов нет, а без `category-key=""` набор сгруппировал бы карточки
                   под пустым заголовком. Имя группы — заголовок над ней: без него диктор объявлял
                   «группа переключателей» без названия (`/code-review`, PR #89). -->
              <B24PageCardGroup
                v-model="selected"
                :items="surveyCards"
                aria-labelledby="new-link-heading"
                category-key=""
                columns="3"
                size="sm"
                color="air-primary"
              />
              <B24Button
                class="mt-4"
                color="air-primary"
                label="Выпустить ссылку"
                :loading="issuing && reissuing === 0"
                :disabled="selectedSurvey === undefined || busy"
                data-testid="issue"
                @click="issueSelected"
              />
              <!-- Отказ выпуска — здесь, у кнопки: почему — у `refusalNear`. -->
              <B24Alert
                v-if="refusal && refusalNear === 'picker'"
                class="mt-3"
                color="air-primary-alert"
                title="Не получилось"
                :description="refusal"
                :actions="refusalActions"
                data-testid="refusal"
              />
            </section>
          </template>

          <!--
            ⚠ Одним блоком: что выпущено, адрес с копированием внутри поля и «ещё одну»
            (issue #84, п. 3). Раньше это были три отдельные полосы во всю ширину вкладки.

            ⚠ Вне цепочки «ещё настраивается» / «сделка не определена» / выбор, а не её веткой:
            перечитка, после которой выпускать стало не по чему (анкету сняли с публикации) или
            которая вернула «ещё настраивается» (администратор переустанавливает приложение), не
            должна смахнуть с экрана только что выпущенный адрес — почему, у `issued`. Внутри
            цепочки карточка пряталась вместе со всем содержимым (`/review`, `/code-review`, PR #89).
          -->
          <!--
            ⚠ Карточка нейтральная, успех — значком у первой строки. Вариант `outline-success`
            красил зелёным ВЕСЬ текст, и подсказка «браузер не дал скопировать» читалась как
            успех, а длинный текст зелёным на белом — хуже, чем тёмным (видно на скриншоте).
          -->
          <B24Card
            v-if="issued !== null"
            data-testid="issued"
          >
            <div class="flex flex-col gap-3">
              <p class="flex items-start gap-2">
                <CircleCheckIcon class="size-5 shrink-0 text-(--ui-color-accent-main-success)" />
                <span>
                  <span class="font-semibold">Ссылка выпущена:</span>
                  {{ issuedNote }}
                </span>
              </p>
              <!--
                ⚠ Кнопка копирования — значком, ровно как в примере «With copy button» у `B24Input`.
                С подписью она не помещалась в место, которое поле держит под значок: хвост адреса
                уходил ПОД кнопку и просвечивал сквозь неё. Подпись живёт в подсказке и `aria-label`,
                а что вышло — словами в строке ниже.
              -->
              <B24Input
                ref="urlInput"
                :model-value="issued.url"
                readonly
                class="w-full"
                aria-label="Адрес анкеты"
                :b24ui="{ trailing: 'pe-0.5' }"
              >
                <template #trailing>
                  <B24Tooltip
                    :text="copyLabel"
                    :content="{ side: 'right' }"
                  >
                    <B24Button
                      :icon="copied ? CircleCheckIcon : CopyIcon"
                      :aria-label="copyLabel"
                      :b24ui="{ leadingIcon: copied ? 'text-(--ui-color-accent-main-success)' : 'text-(--ui-btn-color)' }"
                      color="air-tertiary-no-accent"
                      size="sm"
                      data-testid="copy"
                      @click="copyLink"
                    />
                  </B24Tooltip>
                </template>
              </B24Input>
              <!-- Живая область стоит всегда, меняется только текст: почему — у `copyStatus`. -->
              <p
                class="-mt-2 text-sm"
                role="status"
                data-testid="copy-status"
              >
                {{ copyStatus }}
              </p>
              <div v-if="surveys.length > 0">
                <B24Button
                  size="sm"
                  color="air-secondary-no-accent"
                  label="Выпустить ещё одну"
                  @click="issued = null"
                />
              </div>
            </div>
          </B24Card>
        </template>
      </div>
    </template>
  </B24DashboardPanel>
</template>
