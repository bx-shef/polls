import { SURVEY_STAGE_NAMES, TEMPLATE_STAGE_NAMES } from '../../../shared/portal-names'
import { buildFieldName, camelFieldName, readFlag } from './smart-processes'
import type { PortalCall, SmartProcessRef } from './smart-processes'

/**
 * Native stages of our two smart processes: what each stage means and how the funnel is set up.
 *
 * ⚠ ШТАТНЫЕ СТАДИИ ВМЕСТО СВОЕГО ПОЛЯ «СОСТОЯНИЕ» — решение владельца 28.09 (issue #84, п. 21):
 * «используй штатный механизм — настрой статусы нормально — свои упраздни». До ревизии 5 состояние
 * жило текстовым полем `STATE`: портал его не понимал, канбана не было, робот на «опрос пройден»
 * не повесить. Стадия — это и канбан, и полоса в карточке, и триггеры роботов клиента.
 *
 * ⚠ ДВА РЕЖИМА, И ЭТО НЕ НЕРЕШИТЕЛЬНОСТЬ. Смарт-процесс со стадиями узнаётся по `categoryId`
 * в сохранённой ссылке: его ставит миграция ревизии 5, когда стадии включены и воронка
 * настроена. Без него элемент живёт по-старому, полем `STATE`. Прежний путь нужен в трёх
 * случаях, и только первый проходит сам:
 * - в окно выката, пока миграция ещё не дошла до портала (стадии выключены — `stageId` портал
 *   молча отбрасывает, замерено 28.09);
 * - у смарт-процесса, найденного по названию («усыновлённого»), чьи стадии выключены: стадии
 *   чужого процесса мы не включаем;
 * - на портале, чей тариф не даёт включить стадии.
 * Два последних — навсегда, поэтому второй режим не временный. Писать `stageId` туда, где стадий
 * нет, значило бы терять состояние молча. Переходное окно между переключением и переносом режимом
 * не считается: в нём элементы читаются правильно и так (`carriesLegacyPublished`).
 *
 * ⚠ СТАДИЯ — ОТРАЖЕНИЕ, А НЕ ПРАВДА. Её двигают в канбане сотрудники и роботы клиента, поэтому
 * приложение стадией только ПИШЕТ, а решает по тому, что человеку не сдвинуть:
 * - у «Шаблона» публикацию решает закрытое поле «Дата публикации» — его пишет только наша
 *   публикация, после проверки схемы (разбор у `templateStateOf`). Опирайся код на стадию —
 *   перетаскивание в «Опубликован» выпускало бы анкету в обход проверок, а обратно в «Черновик» —
 *   открывало бы опубликованную версию для правки. Ровно этот обход владелец и показал на живой
 *   проверке, правкой поля `STATE` руками;
 * - у «Результата опросов» «пройдена» — закрытое поле «Дата прохождения», «отозвана» — наша строка
 *   `link_index`, которая и закрывает страницу (разбор у `issuedState`). Нашли `/review`,
 *   `/code-review` и безопасность в панели PR #93.
 */

/** A smart process whose funnel is set up: its stage ids are `DT<entityTypeId>_<categoryId>:<code>`. */
export type StagedRef = SmartProcessRef & { categoryId: number }

/** A stage we keep: which portal stage it is, and how we name and colour it. */
export interface StageSpec {
  /** The code after the colon: `DT1040_16:SUCCESS` → `SUCCESS`. */
  code: string
  name: string
  /**
   * The name the portal gives this stage in a new funnel.
   *
   * ⚠ Переименовываем, только пока стадия носит ИМЕННО его: название, данное администратором,
   * не трогаем — иначе повтор незавершённой миграции спорил бы с ним каждый час. Тот же принцип,
   * что у названий смарт-процессов в ревизии 4.
   */
  portalName: string
  color: string
}

/** What a survey link is: sent, answered, or revoked. Expiry is counted from the date, not staged. */
export type SurveyState = 'sent' | 'completed' | 'revoked'

/**
 * Stages of «[sh] Результат опросов».
 *
 * ⚠ Только системные стадии новой воронки — «Начало», «Успех», «Провал», — переименованные.
 * Удалить их нельзя (`crm.status.delete` отвечает, что системную удаляют только с `FORCED`,
 * замерено 28.09), а свои коды рядом с ними были бы вторым набором тех же смыслов. «Истекла»
 * стадией пока не стала: переводить в неё некому — истечение считается по сроку на чтении,
 * как и до ревизии 5. Своей стадией оно станет вместе с тем, кто будет переводить.
 */
export const SURVEY_STAGES: Readonly<Record<SurveyState, StageSpec>> = {
  sent: { code: 'NEW', name: SURVEY_STAGE_NAMES.sent, portalName: 'Начало', color: '#2FC6F6' },
  completed: { code: 'SUCCESS', name: SURVEY_STAGE_NAMES.completed, portalName: 'Успех', color: '#9DCF00' },
  revoked: { code: 'FAIL', name: SURVEY_STAGE_NAMES.revoked, portalName: 'Провал', color: '#A8ADB4' },
}

/** Where a template stands in its funnel. */
export type TemplateStage = 'draft' | 'published' | 'retired'

/**
 * Stages of «[sh] Шаблон опроса».
 *
 * «Снят с публикации» — единственное, что стадия у шаблона решает сама: перетащив туда
 * опубликованную версию, администратор перестаёт предлагать её для выпуска ссылок. Это
 * безопасное направление — выпускать становится меньше, а не больше.
 */
export const TEMPLATE_STAGES: Readonly<Record<TemplateStage, StageSpec>> = {
  draft: { code: 'NEW', name: TEMPLATE_STAGE_NAMES.draft, portalName: 'Начало', color: '#2FC6F6' },
  published: { code: 'SUCCESS', name: TEMPLATE_STAGE_NAMES.published, portalName: 'Успех', color: '#9DCF00' },
  retired: { code: 'FAIL', name: TEMPLATE_STAGE_NAMES.retired, portalName: 'Провал', color: '#A8ADB4' },
}

/**
 * Stages every new funnel gets and we do not use.
 *
 * Удаляются, пока носят имя портала: переименованную администратором стадию он, видимо,
 * завёл под себя. Стадию с элементами портал не удалит и сам — отказ принимается молча.
 */
export const UNUSED_STAGES: readonly { code: string, portalName: string }[] = [
  { code: 'PREPARATION', portalName: 'Подготовка' },
  { code: 'CLIENT', portalName: 'Согласование' },
]

/** Whether the smart process lives on native stages — its funnel is set up by revision 5. */
export function isStaged(ref: SmartProcessRef): ref is StagedRef {
  return ref.categoryId !== undefined
}

/** The full stage id: `DT1040_16:SUCCESS`. */
export function stageId(ref: StagedRef, code: string): string {
  return `DT${ref.entityTypeId}_${ref.categoryId}:${code}`
}

/**
 * The stage code of an item's `stageId`, or `null` when it is not a stage of this funnel.
 *
 * ⚠ Чужой префикс — не наша стадия. Элемент другой воронки (включи клиент воронки сам) под нашим
 * именем стадии прочитался бы тем же состоянием, что и наш.
 */
export function stageCodeOf(ref: StagedRef, value: unknown): string | null {
  if (typeof value !== 'string') return null
  const prefix = `DT${ref.entityTypeId}_${ref.categoryId}:`
  return value.startsWith(prefix) ? value.slice(prefix.length) : null
}

/** The status-list entity of the funnel's stages: `DYNAMIC_1040_STAGE_16`. */
export function stageEntityId(ref: StagedRef): string {
  return `DYNAMIC_${ref.entityTypeId}_STAGE_${ref.categoryId}`
}

/**
 * Which state the element's stage (or old field) shows: `sent`, `completed`, `revoked`, or empty.
 *
 * ⚠ ЭТО ОТРАЖЕНИЕ, А НЕ ПРАВДА О ССЫЛКЕ. Стадию двигают люди и роботы клиента; правду о ссылке
 * решают закрытое поле «Дата прохождения» и наша строка `link_index` (`issuedState`). Отсюда
 * читает только живая проверка `verify:link` — ей и нужно узнать, доехала ли наша запись.
 * Пусто — не знаем: стадия чужая или поле `STATE` пустое.
 */
export function surveyStateOf(ref: SmartProcessRef, item: Record<string, unknown>): SurveyState | '' {
  if (!isStaged(ref)) {
    const state = asText(item[buildFieldName(ref.id, 'STATE')])
    return state === 'sent' || state === 'completed' || state === 'revoked' ? state : ''
  }
  const code = stageCodeOf(ref, item.stageId)
  const found = (Object.keys(SURVEY_STAGES) as SurveyState[]).find(state => SURVEY_STAGES[state].code === code)
  return found ?? ''
}

/** The fields that put a survey link's element into a state — a stage, or the old field. */
export function surveyStateFields(ref: SmartProcessRef, state: SurveyState): Record<string, unknown> {
  return isStaged(ref)
    ? { stageId: stageId(ref, SURVEY_STAGES[state].code) }
    : { [buildFieldName(ref.id, 'STATE')]: state }
}

/**
 * Puts a survey link's element into a state, and changes nothing else.
 *
 * ⚠ ОТДЕЛЬНЫМ ВЫЗОВОМ, а не вместе с ответами. На штатной стадии клиент вправе сделать поля
 * обязательными («заполнить до перехода в «Пройдена»»), и тогда портал отвергает всю запись
 * целиком. Едь стадия в одном вызове с ответами, ответ крутился бы в буфере до предельного срока
 * хранения и пропал — нарушение инварианта «ответ клиента не теряется никогда». Нашёл `/review`
 * в панели PR #93.
 */
export function buildSurveyStateCall(ref: SmartProcessRef, itemId: number, state: SurveyState): PortalCall {
  return {
    method: 'crm.item.update',
    params: { entityTypeId: ref.entityTypeId, id: itemId, useOriginalUfNames: 'Y', fields: surveyStateFields(ref, state) },
  }
}

/**
 * Where a template stands: `draft`, `published`, `retired`, or empty when unknown.
 *
 * ⚠ СО СТАДИЯМИ «ОПУБЛИКОВАНО» РЕШАЕТ ДАТА ПУБЛИКАЦИИ, А НЕ СТАДИЯ (почему — в шапке модуля).
 * Дату пишет только наша публикация, после проверки схемы, и поле закрыто от правки руками. Старое
 * закрытое поле со значением «published», пока перенос его не снял, значит то же, что дата
 * (`carriesLegacyPublished`).
 * - Ни даты, ни старого «published» — черновик, куда бы его ни перетащили: выпускать по нему
 *   нельзя, править можно.
 * - Опубликован, стадия «Снят с публикации» — снят: выпускать нельзя, править нельзя.
 * - Опубликован, стадия любая другая — опубликован: править нельзя. Выпускать при этом можно
 *   только из стадии «Опубликован» — это решает `isIssuable`, а не здесь.
 * Без стадий — по-старому, полем `STATE`: там оно закрыто от правки и и есть правда.
 */
export function templateStateOf(ref: SmartProcessRef, item: Record<string, unknown>): TemplateStage | '' {
  if (!isStaged(ref)) {
    const state = asText(item[buildFieldName(ref.id, 'STATE')])
    return state === 'draft' || state === 'published' ? state : ''
  }
  const published = asText(item[buildFieldName(ref.id, 'PUBLISHED_AT')]) !== '' || carriesLegacyPublished(ref, item)
  if (!published) return 'draft'
  return stageCodeOf(ref, item.stageId) === TEMPLATE_STAGES.retired.code ? 'retired' : 'published'
}

/**
 * Whether the element still carries the old field's «published» — the carry has not reached it yet.
 *
 * ⚠ ПОКА ПЕРЕНОС НЕ СНЯЛ СТАРОЕ ПОЛЕ, ОНО — ТОЖЕ ПРАВДА О ПУБЛИКАЦИИ. Смарт-процесс переключается
 * на стадии сразу (ссылки сохраняются до переноса), а опубликованные полем анкеты даты не имеют:
 * у всех двенадцати анкет тестового портала она пуста (замерено 28.09). Без этого правила они
 * от переключения до переноса — миг, а при сбое переноса и дольше — читались бы правимыми
 * черновиками. Поле закрыто от правки (ревизия 4), пишет его только приложение; перенос снимает
 * его с каждого переведённого элемента, а потом удаляет целиком. Первая редакция держала шаблоны
 * на старом поле до переноса, и каждый круг ревью находил в этом окне новый край — эта заменила
 * окно правилом чтения. Третий круг панели PR #93.
 */
function carriesLegacyPublished(ref: SmartProcessRef, item: Record<string, unknown>): boolean {
  return asText(item[buildFieldName(ref.id, 'STATE')]) === 'published'
}

export { isFrozen } from '../../../shared/template-state'

/**
 * Whether a link may be issued by this template version.
 *
 * ⚠ Со стадиями — И публикация (дата или старое поле до переноса, `templateStateOf`), И стадия
 * «Опубликован». Версию, которую администратор перетащил в «Черновик», выпускать перестаём: он
 * увидел в канбане «не опубликована» и вправе ждать именно этого. Обратное — черновик, перетащенный
 * в «Опубликован», — выпускать нельзя: его схему никто не проверял. Исключение одно — анкета,
 * которую перенос ещё не перевёл (ниже).
 */
export function isIssuable(ref: SmartProcessRef, item: Record<string, unknown>): boolean {
  if (templateStateOf(ref, item) !== 'published') return false
  // ⚠ Стадии нет у элемента вовсе — администратор выключил стадии у смарт-процесса (портал тогда
  // прячет `stageId`, замерено 28.09). Сужать нечем, решает одна дата: иначе выпуск молча встал бы
  // целиком, без следа в журнале. Нашёл `/code-review` во втором круге панели PR #93.
  if (!isStaged(ref) || item.stageId === undefined) return true
  const code = stageCodeOf(ref, item.stageId)
  if (code === TEMPLATE_STAGES.published.code) return true
  // Опубликованная полем и ещё не перенесённая стоит в первой стадии: перенос переведёт её
  // в «Опубликован» и снимет старое поле. До тех пор выпуск по ней — как и до ревизии 5.
  return code === TEMPLATE_STAGES.draft.code && carriesLegacyPublished(ref, item)
}

/** The fields that put a template element into a stage — a stage, or the old field. */
export function templateStateFields(ref: SmartProcessRef, stage: 'draft' | 'published'): Record<string, unknown> {
  return isStaged(ref)
    ? { stageId: stageId(ref, TEMPLATE_STAGES[stage].code) }
    : { [buildFieldName(ref.id, 'STATE')]: stage }
}

/**
 * The fields an operator command puts a template into a state with: the stage, and the old field while it lives.
 *
 * `legacyField` — старое поле «Состояние» ещё на портале. Почему команда пишет его рядом со стадией,
 * разобрано у `writesLegacyState` (`server/b24/write-templates.ts`): вебхук не видит, чем читает
 * приложение. Приложение само этим не пользуется — свой режим оно знает точно.
 */
export function commandStateFields(ref: SmartProcessRef, stage: 'draft' | 'published', legacyField: boolean): Record<string, unknown> {
  return { ...templateStateFields(ref, stage), ...(legacyField ? { [buildFieldName(ref.id, 'STATE')]: stage } : {}) }
}

/** Turns stages on for a smart process. */
export function buildEnableStagesCall(ref: SmartProcessRef): PortalCall {
  return { method: 'crm.type.update', params: { id: ref.id, fields: { isStagesEnabled: true } } }
}

/** Lists the funnels of a smart process. */
export function buildListCategoriesCall(ref: SmartProcessRef): PortalCall {
  return { method: 'crm.category.list', params: { entityTypeId: ref.entityTypeId } }
}

/**
 * The id of the default funnel, or `null` when the answer has none.
 *
 * ⚠ Воронка по умолчанию есть у смарт-процесса ВСЕГДА, даже с выключенными стадиями и воронками
 * (замерено 28.09: «Общая воронка», `isDefault: 'Y'`). Её идентификатор у каждого портала свой
 * и входит в код каждой стадии, поэтому читается, а не угадывается.
 */
export function readDefaultCategoryId(response: unknown): number | null {
  const categories = (response as { result?: { categories?: unknown } } | null)?.result?.categories
  if (!Array.isArray(categories)) return null
  // Флаг — через `readFlag`: портал отдаёт его и `'Y'`, и `true`, и сравнение с одной формой
  // однажды не нашло бы воронку вовсе. Нашёл `/code-review` во втором круге панели PR #93.
  const found = categories.find(category => readFlag((category as { isDefault?: unknown }).isDefault) === true)
  const id = Number((found as { id?: unknown } | undefined)?.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Lists the stages of the funnel. */
export function buildListStagesCall(ref: StagedRef): PortalCall {
  return { method: 'crm.status.list', params: { filter: { ENTITY_ID: stageEntityId(ref) }, order: { SORT: 'ASC' } } }
}

/** A stage as the portal has it. */
export interface ExistingStage {
  /** The status-list record id — what `crm.status.update` and `crm.status.delete` take. */
  id: number
  code: string
  name: string
}

/** Reads `crm.status.list`, keeping only stages of this funnel. `null` — not an answer of that shape. */
export function readStages(response: unknown, ref: StagedRef): ExistingStage[] | null {
  const rows = (response as { result?: unknown } | null)?.result
  if (!Array.isArray(rows)) return null
  return rows.flatMap((row) => {
    const bag = row as { ID?: unknown, STATUS_ID?: unknown, NAME?: unknown }
    const id = Number(bag.ID)
    const code = stageCodeOf(ref, bag.STATUS_ID)
    return Number.isInteger(id) && id > 0 && code !== null ? [{ id, code, name: asText(bag.NAME) }] : []
  })
}

/**
 * Calls that bring the funnel to our stages: rename ours, drop the unused ones.
 *
 * Трогаем только то, что ещё носит имя портала (почему — у `StageSpec.portalName`). Повторный
 * прогон на настроенной воронке — ни одного вызова.
 */
export function planStages(specs: readonly StageSpec[], existing: readonly ExistingStage[]): PortalCall[] {
  const calls: PortalCall[] = []
  for (const spec of specs) {
    const stage = existing.find(one => one.code === spec.code)
    if (stage === undefined || stage.name !== spec.portalName) continue
    calls.push({ method: 'crm.status.update', params: { id: stage.id, fields: { NAME: spec.name, COLOR: spec.color } } })
  }
  for (const unused of UNUSED_STAGES) {
    const stage = existing.find(one => one.code === unused.code)
    if (stage === undefined || stage.name !== unused.portalName) continue
    calls.push({ method: 'crm.status.delete', params: { id: stage.id } })
  }
  return calls
}

/** Which of our smart processes a carry works on: they differ in what the old field held. */
export type CarryKind = 'template' | 'survey'

/**
 * The old values each carry moves; the filter and the moves both take them from here.
 *
 * ⚠ ОДНА КОПИЯ НА ОТБОР И НА ПЕРЕВОД. Разойдись они, отбор приносил бы строки, которые перевод
 * пропускает, проход выглядел бы чистым, и поле удалилось бы вместе с их состоянием. Первая
 * редакция сравнивала в переводе свои строки. Нашёл `/code-review` в панели PR #93.
 */
const CARRIED_VALUES = {
  template: ['published'],
  survey: ['completed', 'revoked'],
} as const satisfies Record<CarryKind, readonly string[]>

/** Whether an old value is one the carry of this kind moves. */
function isCarried<K extends CarryKind>(kind: K, value: string): value is (typeof CARRIED_VALUES)[K][number] {
  return (CARRIED_VALUES[kind] as readonly string[]).includes(value)
}

/**
 * One page of the elements the carry still has to move, after the element `afterId`.
 *
 * ⚠ ОТБИРАЕТ ПОРТАЛ, И ТОЛЬКО ТО, ЧТО НАДО ПЕРЕВЕСТИ: первая стадия и старое поле со значением,
 * которое стадию меняет. Первая редакция листала все элементы с `select: ['*']` — на портале
 * с сотнями опросов перенос не укладывался в бюджет обустройства (портал уходил в `degraded`),
 * а в память сервера ехали ответы клиентов, которые переносу не нужны. Нашли `/review`,
 * `/code-review` и безопасность в панели PR #93.
 *
 * ⚠ БЕЗ `useOriginalUfNames` И В CAMELCASE — единственная форма, в которой узкий `select` отдаёт
 * `id`, `stageId` и `updatedTime` (у `camelFieldName`). Отбор и `>id` замерены на портале 28.09.
 *
 * ⚠ Листаем по `>id`, а не смещением: переведённые элементы выпадают из отбора, и смещение
 * перескакивало бы через непрочитанные.
 */
export function buildCarryListCall(ref: StagedRef, kind: CarryKind, afterId: number): PortalCall {
  const state = camelFieldName(ref.id, 'STATE')
  const own = kind === 'template' ? ['PUBLISHED_AT', 'CODE', 'VERSION', 'SCHEMA'].map(postfix => camelFieldName(ref.id, postfix)) : []
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: ref.entityTypeId,
      select: ['id', 'stageId', 'updatedTime', state, ...own],
      // ⚠ Шаблоны — в ЛЮБОЙ стадии, опросы — только в первой. Опубликованная полем анкета без даты,
      // которую администратор успел перетащить из «Черновика» до переноса, иначе не получила бы даты,
      // и после удаления поля навсегда читалась бы правимым черновиком. Стадию при этом переводим
      // только из первой: куда её увёл администратор, там она и останется. Нашёл `/review`
      // во втором круге панели PR #93. Значения — из `CARRIED_VALUES`: одна копия на отбор и перевод.
      filter: kind === 'template'
        ? { '>id': afterId, [state]: CARRIED_VALUES.template[0] }
        : { 'stageId': stageId(ref, 'NEW'), '>id': afterId, [`@${state}`]: [...CARRIED_VALUES.survey] },
      order: { id: 'ASC' },
    },
  }
}

/**
 * Reads a carry page into elements under our original field names — what `planStageMoves` reads.
 *
 * `null` — ответ не прочитать: не той формы, ИЛИ в строке нет номера элемента или самого старого
 * поля. ⚠ Не пустой список и не пропуск строки: пустое значит «переносить нечего», и поле удалилось
 * бы вместе с состоянием элементов, которых мы просто не прочитали. Другое написание поля у портала
 * выглядело бы ровно так. Нашли `/review` и `/code-review` во втором круге панели PR #93.
 *
 * Поле есть, а значение не наше (например, «Published», правленное руками до ревизии 4, которое
 * отбор портала, похоже, находит без учёта регистра), — строку читаем, а перевод её пропускает
 * (`isCarried`): прежний код её опубликованной не считал, и перенос не должен ни переводить её,
 * ни застревать на ней навсегда. Нашёл `/review` в третьем круге панели PR #93.
 */
export function readCarryItems(response: unknown, ref: StagedRef, kind: CarryKind): Record<string, unknown>[] | null {
  const items = (response as { result?: { items?: unknown } } | null)?.result?.items
  if (!Array.isArray(items)) return null
  const postfixes = kind === 'template' ? ['STATE', 'PUBLISHED_AT', 'CODE', 'VERSION', 'SCHEMA'] : ['STATE']
  const stateKey = camelFieldName(ref.id, 'STATE')
  const read: Record<string, unknown>[] = []
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    const id = Number(item.id)
    if (!Number.isInteger(id) || id <= 0 || !(stateKey in item)) return null
    const own = Object.fromEntries(postfixes.map(postfix => [buildFieldName(ref.id, postfix), item[camelFieldName(ref.id, postfix)]]))
    read.push({ id, stageId: item.stageId, updatedTime: item.updatedTime, ...own })
  }
  return read
}

/**
 * Moves that carry the old `STATE` over to stages, for the elements of one page.
 *
 * `moveOf` — что записать в элемент по старому полю; `null` — оставить как есть.
 */
export function planStageMoves(
  ref: StagedRef,
  items: readonly Record<string, unknown>[],
  moveOf: (item: Record<string, unknown>) => Record<string, unknown> | null,
): PortalCall[] {
  return items.flatMap((item) => {
    const id = Number(item.id)
    const fields = moveOf(item)
    if (!Number.isInteger(id) || id <= 0 || fields === null) return []
    return [{
      method: 'crm.item.update',
      params: { entityTypeId: ref.entityTypeId, id, useOriginalUfNames: 'Y', fields },
    }]
  })
}

/**
 * What a survey link's element gets by its old `STATE`: answered or revoked; the rest stay first.
 *
 * ⚠ ТОЛЬКО ИЗ ПЕРВОЙ СТАДИИ. Включённые стадии ставят все прежние элементы в первую, а миграция
 * идёт на живом портале, и пока она листает страницы, элемент могут уже перевести по-новому:
 * опрос пройден — «Пройдена». Переведя его по старому полю, прочитанному раньше, мы вернули бы
 * его назад. Элемент не в первой стадии уже переведён — им, новым кодом или человеком.
 */
export function surveyMoveOf(ref: StagedRef): (item: Record<string, unknown>) => Record<string, unknown> | null {
  const field = buildFieldName(ref.id, 'STATE')
  const first = stageId(ref, 'NEW')
  return (item) => {
    const state = asText(item[field])
    if (item.stageId !== first || !isCarried('survey', state)) return null
    return { stageId: stageId(ref, SURVEY_STAGES[state].code) }
  }
}

/**
 * What a template element gets by its old `STATE`: published — the stage and, when missing, the date.
 *
 * ⚠ ДАТУ ДОСЫЛАЕМ, иначе миграция сняла бы с публикации ВСЁ. Замерено 28.09 на тестовом портале:
 * у всех двенадцати опубликованных анкет «Дата публикации» пуста — их публиковали переносом и правкой
 * поля руками, до того как публикация научилась её писать. Со стадиями правда о публикации — дата
 * (`templateStateOf`), и без неё они стали бы черновиками, а выпускать ссылки стало бы не по чему.
 * Уже опубликованное принимаем как есть, а все новые обходы проверок этот модуль закрывает.
 * Дата — день последней правки элемента: у неизменяемой версии это и есть публикация, а «сегодня»
 * соврало бы в единственном поле, по которому потом восстанавливают, когда анкета вышла. `today` —
 * только запасной день, когда правка не прочиталась.
 */
export function templateMoveOf(ref: StagedRef, today: string): (item: Record<string, unknown>) => Record<string, unknown> | null {
  const stateField = buildFieldName(ref.id, 'STATE')
  const dateField = buildFieldName(ref.id, 'PUBLISHED_AT')
  const first = stageId(ref, 'NEW')
  return (item) => {
    if (!isCarried('template', asText(item[stateField]))) return null
    // Правка элемента не прочиталась — сегодняшний день: неточная дата лучше снятой публикации.
    const updated = asText(item.updatedTime).slice(0, 10)
    const day = /^\d{4}-\d{2}-\d{2}$/.test(updated) ? updated : today
    const missing = asText(item[dateField]) === ''
    // Стадию — только из первой: куда её увёл администратор, там она и останется. Дату — всегда,
    // когда её нет: без неё после удаления поля анкета стала бы черновиком (разбор у `buildCarryListCall`).
    // ⚠ Старое поле СНИМАЕМ той же записью. Переведённая анкета больше не «опубликована полем»:
    // повтор переноса её не найдёт и не вернёт в «Опубликован» после того, как администратор увёл её
    // в «Черновик», а чтение перестанет считать её неперенесённой (`carriesLegacyPublished`).
    // Нашёл `/review` в третьем круге панели PR #93.
    return {
      ...(item.stageId === first ? { stageId: stageId(ref, TEMPLATE_STAGES.published.code) } : {}),
      ...(missing ? { [dateField]: day } : {}),
      [stateField]: '',
    }
  }
}

function asText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}
