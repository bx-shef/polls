<script setup lang="ts">
import CircleCheckIcon from '@bitrix24/b24icons-vue/outline/CircleCheckIcon'
import CopyIcon from '@bitrix24/b24icons-vue/outline/CopyIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { copyToClipboard } from '~/utils/clipboard'
import { readFramePass } from '~/utils/frame-auth'
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

/** Опубликованная анкета, как её отдаёт сервер: чем выбирать, без самой схемы. */
interface Survey {
  code: string
  version: number
  title: string
  /** Сколько разделов и вопросов в версии — строчка под названием карточки. */
  sections: number
  questions: number
}

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

/** Списки не пришли при открытии. Совет — кнопка «Обновить» в той же плашке, а не «обновите страницу». */
const LOAD_FAILURE = 'Не удалось получить список опросов с портала. Нажмите «Обновить», чтобы попробовать ещё раз.'

/** Перечитка сорвалась, а прежние списки на экране есть: они остаются, и сказано, что могли устареть. */
const REFRESH_FAILURE = 'Не удалось перечитать анкеты с портала — на экране может быть устаревший список. Попробуйте обновить ещё раз.'

const PLURAL = new Intl.PluralRules('ru-RU')

/**
 * Неразрывный пробел — кодом символа, а не самим символом: в исходнике он неотличим от обычного,
 * и следующая правка заменила бы его пробелом молча (линтер такие символы вдобавок не пропускает).
 */
const NBSP = String.fromCharCode(0xA0)

/**
 * Число со словом в нужной форме: «1 раздел», «3 раздела», «5 разделов».
 *
 * Между числом и словом — неразрывный пробел: строка переносится по « · », а не между «3» и «раздела».
 */
function counted(value: number, one: string, few: string, many: string): string {
  const form = PLURAL.select(value)
  return `${value}${NBSP}${form === 'one' ? one : form === 'few' ? few : many}`
}

/** Ключ анкеты в выборе. Код и версия вместе: две версии одной анкеты бывают опубликованы разом. */
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
const selectedSurvey = computed(() => surveys.value.find(survey => surveyKey(survey) === selected.value))

/** Только что выпущенная ссылка. Токен в ней показывается ОДИН раз — у нас лежит только его хеш. */
const issued = ref<{ url: string, expiresAt: string, title: string } | null>(null)
const copied = ref(false)
/** Скопировать не вышло ни одним путём: адрес выделен, и человеку сказано, какие клавиши нажать. */
const copyFailed = ref(false)
/** Имя кнопки копирования — для подсказки и экранного диктора: сама кнопка — значок. */
const copyLabel = computed(() => copied.value ? 'Скопировано' : 'Скопировать ссылку')
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

/**
 * Имя вкладки — то же, под которым портал показывает её в карточке сделки.
 *
 * ⚠ С меткой владельца `[sh]` (решение 28.09, issue #84, п. 22): так вкладка и смарт-процессы
 * приложения не путаются с одноимёнными у клиента. Регистрирует вкладку сервер — имя там и здесь
 * обязано совпадать, иначе человек ищет в карточке вкладку, которой под этим именем нет.
 */
const TAB_TITLE = '[sh] Ссылки на опросы'

useHead({ title: TAB_TITLE })

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
    if (!await readLists()) failure.value = LOAD_FAILURE
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
function pass() {
  const parsed = readFramePass(frame!.auth.getAuthData())
  if (parsed === null) throw new Error('нет данных авторизации фрейма')
  return { memberId: parsed.memberId, authId: parsed.authId }
}

/**
 * Прочитать оба списка. `false` — не пришёл список анкет; список ссылок своих отказов не поднимает.
 */
async function readLists(): Promise<boolean> {
  try {
    // Список и выбор грузятся вместе: это два независимых обращения, и ждать их по очереди
    // значит показывать ожидание вдвое дольше без единой причины.
    await Promise.all([loadSurveys(), loadLinks()])
    return true
  }
  catch {
    return false
  }
}

/**
 * Перечитать оба списка по кнопке «Обновить».
 *
 * ⚠ Только по нажатию, а не по таймеру (issue #84, п. 1). Каждая перечитка — это обращения
 * к порталу КЛИЕНТА, в его лимиты REST, а вкладка может висеть открытой часами: перечитка раз
 * в минуту тратила бы чужие лимиты на экран, на который никто не смотрит.
 *
 * ⚠ Только что выпущенную ссылку перечитка НЕ убирает — ни удачная, ни сорвавшаяся. Токен
 * показывается один раз, у нас лежит только его хеш: смахнув адрес с экрана, мы отняли бы его
 * навсегда. Поэтому сорвавшаяся перечитка поверх прежних списков — это отказ действия над ними,
 * а не `failure`, встающий вместо всего; `failure` остаётся только у вкладки, которой показать
 * нечего с самого открытия. Снимается он ПОСЛЕ ответа, а не до запроса: сними его заранее —
 * и на время перечитки из-под плашки выглядывала бы ветка «опросов пока нет».
 */
async function refresh(): Promise<void> {
  if (frame === undefined || busy.value) return
  refreshing.value = true
  refusal.value = ''
  refusalNear.value = 'top'
  try {
    if (await readLists()) failure.value = ''
    else if (failure.value === '') refuse('lists-stale', REFRESH_FAILURE)
  }
  finally {
    refreshing.value = false
  }
}

async function loadSurveys() {
  const result = await $fetch<{ ok: boolean, reason?: string, surveys?: Survey[] }>(
    '/api/portal/surveys',
    { method: 'POST', body: pass() },
  )
  // ⚠ Признак ставится заново на КАЖДОЙ перечитке, а не только поднимается: администратор мог
  // доустановить приложение, пока вкладка открыта, и «ещё настраивается» обязано уйти по «Обновить».
  notProvisioned.value = !result.ok && result.reason === 'not-provisioned'
  if (!result.ok) return
  surveys.value = result.surveys ?? []
}

/**
 * Список уже выпущенных ссылок.
 *
 * ⚠ Отказ загрузки списка НЕ мешает выпустить новую. Список — это память о прошлом,
 * а выпуск — работа, которую человек пришёл сделать: уронив вкладку целиком из-за первого,
 * мы отняли бы второе.
 */
async function loadLinks() {
  if (dealId.value === null) return
  try {
    const result = await $fetch<{ ok: boolean, links?: IssuedLink[] }>(
      '/api/portal/links',
      { method: 'POST', body: { ...pass(), dealId: dealId.value } },
    )
    links.value = result.ok ? result.links ?? [] : []
  }
  catch {
    links.value = []
  }
}

/** Показать отказ действия: свой текст по причине, иначе общий. */
function refuse(reason: string | undefined, fallback: string): void {
  refusal.value = REFUSALS[reason ?? ''] ?? fallback
  refusalStale.value = STALE_REFUSALS.has(reason ?? '')
}

/**
 * Погасить ссылку.
 *
 * ⚠ Список перечитывается С СЕРВЕРА, а не правится на месте. Состояние ссылки живёт
 * на портале, и «поправить у себя» значит показать то, чего там может не быть: отзыв мог
 * не пройти наполовину, а за время, пока вкладка открыта, ссылку могли пройти.
 */
async function revoke(link: IssuedLink) {
  if (busyItem.value !== 0 || dealId.value === null) return
  busyItem.value = link.itemId
  refusal.value = ''
  refusalNear.value = 'top'

  try {
    const result = await $fetch<{ ok: boolean, reason?: string }>(
      '/api/portal/revoke',
      { method: 'POST', body: { ...pass(), dealId: dealId.value, itemId: link.itemId } },
    )
    if (!result.ok) refuse(result.reason, 'Не удалось отозвать ссылку. Попробуйте ещё раз.')
    await loadLinks()
  }
  catch {
    refuse(undefined, 'Не удалось отозвать ссылку. Попробуйте ещё раз.')
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
  refusalNear.value = 'top'
  const survey = surveys.value.find(item => item.code === link.code && item.version === link.version)
  if (survey === undefined) {
    refuse(undefined, 'Эту анкету сняли с публикации — перевыпустить по ней нельзя. Выберите другую.')
    return
  }

  reissuing.value = link.itemId
  try {
    await revoke(link)
    if (refusal.value !== '') return
    await issue(survey)
  }
  finally {
    reissuing.value = 0
  }
}

async function issue(survey: Survey) {
  if (issuing.value || dealId.value === null) return
  issuing.value = true
  refusal.value = ''

  try {
    const result = await $fetch<{ ok: boolean, reason?: string, url?: string, expiresAt?: string }>(
      '/api/portal/issue',
      {
        method: 'POST',
        body: { ...pass(), dealId: dealId.value, surveyCode: survey.code, surveyVersion: survey.version },
      },
    )
    if (result.ok && result.url !== undefined) {
      issued.value = { url: result.url, expiresAt: result.expiresAt ?? '', title: survey.title }
      copied.value = false
      copyFailed.value = false
      // Следующую ссылку выбирают заново: «ещё одна» — обычно по другой анкете, а выбор,
      // оставшийся от прошлой, превратил бы привычное нажатие в лишний выпуск.
      selected.value = ''
      await loadLinks()
      return
    }
    refuse(result.reason, 'Не удалось выпустить ссылку. Попробуйте ещё раз.')
  }
  catch {
    refuse(undefined, 'Не удалось выпустить ссылку. Попробуйте ещё раз.')
  }
  finally {
    issuing.value = false
  }
}

/**
 * «Обновить» внутри плашки отказа — та же перечитка, что в шапке, кнопкой рядом с текстом.
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

/** Выпустить ссылку по выбранной карточке — второй шаг выбора. Отказ — у этой же кнопки. */
async function issueSelected(): Promise<void> {
  if (selectedSurvey.value === undefined || busy.value) return
  refusalNear.value = 'picker'
  await issue(selectedSurvey.value)
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
  copied.value = await copyToClipboard(issued.value.url)
  copyFailed.value = !copied.value
  if (!copied.value) urlInput.value?.inputRef?.select()
}

/** Дата словами. Пусто — портал её не прислал, и выдумывать нечего. */
function dateLabel(raw: string): string {
  if (raw === '') return ''
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Балл в русской записи — с запятой.
 *
 * ⚠ Та же запись, что у дела в ленте и у поля «Результат опроса» (`formatScore` на сервере):
 * одно прохождение не должно называться «7.5» во вкладке и «7,5» в карточке. Своя строка, а не
 * импорт: `app/` серверных модулей не импортирует — это граница слоёв.
 */
function scoreLabel(score: number): string {
  return String(score).replace('.', ',')
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
  return surveys.value.find(survey => survey.code === link.code && survey.version === link.version)?.title ?? link.code
}

/**
 * Что сказать о ссылке после названия: до какого числа действует, когда истекла, когда пройдена
 * и с каким баллом. У отозванной — ничего: когда её отозвали, портал не хранит, а срок у неё
 * уже ничего не значит.
 */
function linkNote(link: IssuedLink): string {
  if (link.state === 'completed') {
    const when = dateLabel(link.completedAt)
    return [when === '' ? '' : `пройдена ${when}`, link.score === null ? '' : `балл ${scoreLabel(link.score)}`]
      .filter(part => part !== '')
      .join(' · ')
  }
  const until = dateLabel(link.expiresAt)
  if (until === '') return ''
  if (link.state === 'active') return `действует до ${until}`
  if (link.state === 'expired') return `истекла ${until}`
  return ''
}

/** Карточки выбора: название и строчка о содержании — «версия 2 · 3 раздела · 8 вопросов». */
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
        :title="TAB_TITLE"
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
          description="Эта страница живёт внутри портала: ссылку она выпускает для конкретной сделки и без портала не знает ни сделки, ни ваших прав на неё. Откройте карточку сделки и вкладку «[sh] Ссылки на опросы» в ней."
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
              вкладку — и узнать, выпускал ли ты что-нибудь по этой сделке, было нельзя, а сам
              токен не покажется больше никогда.

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
                <ul class="divide-y divide-(--ui-color-design-outline-content-divider)">
                  <li
                    v-for="link in links"
                    :key="link.itemId"
                    class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
                    data-testid="issued-link"
                  >
                    <B24Badge
                      :color="STATES[link.state].color"
                      :label="STATES[link.state].label"
                    />
                    <span class="font-medium">{{ surveyTitle(link) }}</span>
                    <span
                      v-if="linkNote(link)"
                      class="text-sm text-(--ui-color-text-secondary)"
                    >
                      {{ linkNote(link) }}
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
                </ul>
              </B24Card>
            </section>

            <!-- ⚠ «Появляются после переноса из старого решения» здесь было правдой до конструктора.
                 Теперь анкету собирают сами, и совет обязан вести туда, где это делается. -->
            <B24Alert
              v-if="surveys.length === 0"
              color="air-secondary-accent"
              description="Выпускать нечего: на портале нет ни одной опубликованной анкеты. Соберите и опубликуйте её на вкладке «[sh] Конструктор» в карточке «[sh] Шаблон опроса», а потом нажмите «Обновить»."
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
                <h2 class="font-semibold">
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
                   под пустым заголовком. -->
              <B24PageCardGroup
                v-model="selected"
                :items="surveyCards"
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

            <!--
              ⚠ Одним блоком: что выпущено, адрес с копированием внутри поля и «ещё одну»
              (issue #84, п. 3). Раньше это были три отдельные полосы во всю ширину вкладки.

              ⚠ Отдельно от выбора анкеты, а не его веткой: перечитка, после которой выпускать
              стало не по чему (анкету сняли с публикации), не должна смахнуть с экрана адрес,
              который больше не покажется никогда.
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
                <p
                  v-if="copied || copyFailed"
                  class="text-sm"
                  role="status"
                  data-testid="copy-status"
                >
                  {{ copied
                    ? 'Скопировано — вставьте ссылку в письмо или сообщение клиенту.'
                    : 'Браузер не дал скопировать сам. Адрес выделен — нажмите Ctrl+C (на Mac — Cmd+C).' }}
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
        </template>
      </div>
    </template>
  </B24DashboardPanel>
</template>
