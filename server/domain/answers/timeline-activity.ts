import type { SurveyTemplate } from '../surveys/model'
import { Buffer } from 'node:buffer'
import type { SurveyScore } from '../surveys/scoring'
import { DEAL_ENTITY_TYPE_ID, type PortalCall } from '../portals/smart-processes'

/**
 * The survey's activity in the deal timeline: sent with the link, overwritten by the result, closed on revoke.
 *
 * С issue #84 (п. 14) у ссылки одно дело на всю её жизнь: при выпуске — «Отправить опрос клиенту»
 * с адресом анкеты, после ответа — итог, при отзыве — «Ссылка отозвана». Здесь чистые построители
 * вызовов и разбор ответов; кто, когда и в каком порядке их зовёт — `server/b24/survey-activity.ts`.
 *
 * ⚠ ЗАМЕНЯЕТ СОБОЙ КОММЕНТАРИЙ, и ради одного свойства: `crm.timeline.comment.add`
 * НЕ ИДЕМПОТЕНТЕН — второй вызов добавляет второй комментарий, а не обновляет первый.
 * Это стояло в коде как принятый риск с самого начала, и оно прямо противоречит инварианту
 * проекта «перед созданием — поиск существующего». У дела есть метка внешнего источника
 * (`ORIGINATOR_ID` + `ORIGIN_ID`), по которой оно ищется до создания, — то есть портал,
 * а не наша таблица, становится источником правды о том, писали мы уже или нет.
 *
 * Плюс к этому дело умеет то, чего комментарий не умеет вовсе: цвет, срок и признак
 * «не сделано». Оно попадает в список дел ответственного и ловит глаз без того, чтобы
 * кто-то читал таймлайн, — на занятом портале это единственный работающий сигнал.
 *
 * Форма взята у соседа (`client-bank-alfa-by`, `app/utils/todoActivity.ts` и
 * `server/utils/todoActivityWrite.ts`), где она подтверждена живыми порталами. Там же
 * подтверждены цвета человеком, смотревшим на портал: REST возвращает что положили,
 * и никакой код оттенок проверить не может.
 */

/** Метод, создающий универсальное дело в таймлайне. */
export const ACTIVITY_ADD_METHOD = 'crm.activity.todo.add'
/** Метод, которым дело выпуска перезаписывается итогом. */
export const ACTIVITY_TODO_UPDATE_METHOD = 'crm.activity.todo.update'
/** Метод, которым метка и тип описания наносятся следом. */
export const ACTIVITY_UPDATE_METHOD = 'crm.activity.update'
/** Метод поиска по метке. */
export const ACTIVITY_LIST_METHOD = 'crm.activity.list'

/**
 * Пространство имён метки — наше приложение.
 *
 * ⚠ Переименование сделает все ранее записанные дела чужими: поиск перестанет их находить,
 * и следующая же доставка напишет второе дело к каждому уже записанному опросу.
 */
export const ACTIVITY_ORIGINATOR_ID = 'SHEF_SURVEY'

/**
 * Ключ дедупликации итога — элемент «Результата опросов», к которому относится ответ.
 *
 * Приглашение проходится ровно один раз (ссылка одноразовая, статус `completed` закрывает
 * её транзакцией), поэтому «один элемент — одно дело» и есть правильная единица.
 *
 * ⚠ С ТИПОМ СМАРТ-ПРОЦЕССА, а не одним номером элемента (панель PR #102, `/code-review`).
 * У пересозданного смарт-процесса номера элементов считаются заново, а дела живут в сделках
 * и переживают и элементы, и сам тип. Без типа новый элемент 12 нашёл бы дело старого элемента 12
 * из другой сделки — итог «уже записан», и не записался бы вовсе. Тип у пересозданного
 * смарт-процесса новый, поэтому пара «тип + номер» уникальна. Дела, записанные раньше, остаются
 * с прежним ключом `survey-<номер>`: второй раз их не ищут — ссылка одноразовая, а доставленный
 * ответ из буфера удаляется.
 */
export function activityOriginId(entityTypeId: number, itemId: number): string {
  return `survey-${entityTypeId}-${itemId}`
}

/**
 * Ключ дела при выпуске ссылки — «Отправить опрос клиенту» (issue #84, п. 14).
 *
 * ⚠ СВОЙ КЛЮЧ, А НЕ ТОТ ЖЕ, ЧТО У ИТОГА. Доставка ищет «итог уже записан» по ключу итога,
 * а дело выпуска — отдельно. Закрытое менеджером дело выпуска портал перезаписать не даёт,
 * и итог тогда пишется новым делом рядом. С общим ключом повторная доставка нашла бы
 * закрытое дело выпуска и решила бы, что итог уже записан. Перезаписанное итогом дело
 * получает ключ итога, и дальше его ищут как итог.
 *
 * ⚠ Фильтр `ORIGIN_ID` у `crm.activity.list` — точное совпадение, а не поиск подстроки.
 * Замерено 29.09: поиск по началу ключа не нашёл ничего. Иначе ключ элемента 7 находил бы
 * и дела элемента 78. Тип смарт-процесса в ключе — по той же причине, что у итога.
 */
export function linkActivityOriginId(entityTypeId: number, itemId: number): string {
  return `survey-link-${entityTypeId}-${itemId}`
}

/**
 * `DESCRIPTION_TYPE = 2` — BB-код.
 *
 * ⚠ ЗНАЧЕНИЯ СНЯТЫ С ЖИВОГО ПОРТАЛА методом `crm.enum.contenttype`, который документация
 * прямо называет источником значений этого поля. Он отвечает: `1` — Plain text, `2` — bbCode,
 * `3` — HTML. Это НЕ совпадает с тем, что записано у соседа (`DESCRIPTION_TYPE_BB = 3`),
 * и расхождение стоит проверить и там: под тройкой на этом портале лежит HTML.
 *
 * ⚠ Первая редакция ставила `1` (простой текст) — безопасно, но нечитаемо: запись выходила
 * сплошной простынёй без выделений. Владелец попросил блоки, как у соседа. BB безопасен
 * ровно постольку, поскольку разметку строим МЫ, а текст респондента проходит через
 * `neutralizeMarkup` — и тот обезвреживает теперь и квадратные скобки, и угловые, то есть
 * ни BB, ни HTML из ответа постороннего человека собраться не может. Порядок важен: сначала
 * расширили обезвреживание, потом включили разметку.
 *
 * ⚠ Тип нельзя задать при создании: у `crm.activity.todo.add` такого параметра нет.
 * Он едет тем же `crm.activity.update`, что и метка, — одним вызовом, а не двумя.
 *
 * ⚠ ЧТО ПОРТАЛ СТАВИТ САМ — замерено 24.09 по issue #26: сразу после `todo.add`, без нашего
 * второго вызова, у дела уже `DESCRIPTION_TYPE = 2`. Тип поля при этом `crm_enum_contenttype` —
 * портал сам объявляет его перечислением способов разобрать текст, и bbCode один из трёх.
 *
 * ⚠ А 25.09 замерено ГЛАВНОЕ, и оно сильнее. Два дела с одинаковым текстом и типами `1` и `2`
 * лента нарисовала ОДИНАКОВО — жирным и кликабельной ссылкой. То есть разбор BB от этого поля
 * НЕ ЗАВИСИТ: «простой текст» его не выключает. Отсюда два следствия. Первое: значение здесь —
 * честная декларация, а не средство защиты. Второе: понизить его до единицы и снять
 * `neutralizeMarkup` «раз теперь простой текст» нельзя — защита ровно одна, и она в
 * `comment.ts`.
 */
export const DESCRIPTION_TYPE_BB = 2

/**
 * Цвета дела (`colorId` — СТРОКИ, не числа).
 *
 * ⚠ Пара взята у соседа, где её подтвердил человек, смотревший на портал: `4` — зелёный,
 * `7` — розовый. Проверить оттенок кодом нельзя: REST возвращает ровно то, что положили.
 *
 * ⚠ У жёлтого идентификатора НЕТ — он получается, если `colorId` не передать. Значит
 * «цвет не задан» и «цвет жёлтый» на портале неразличимы, и забытый параметр читался бы
 * как осознанный выбор. Поэтому цвет отправляется ВСЕГДА.
 */
export const ACTIVITY_COLOR_GOOD = '4'
export const ACTIVITY_COLOR_BAD = '7'

/**
 * Через сколько истекает срок дела.
 *
 * ⚠ Не «сейчас», и это решение, а не округление. Дело со сроком в текущую секунду становится
 * просроченным через секунду после появления — то есть выглядит поломкой ровно там, где мы
 * только что её и чинили. Сутки — то окно, в котором ответ клиента ещё свежий и разговор
 * с ним имеет смысл; просрочка после них — честный сигнал, что до человека не дошли руки.
 */
export const ACTIVITY_DUE_HOURS = 24

/** Срок для дела по завершённому опросу. */
export function activityDeadline(now: Date): Date {
  return new Date(now.getTime() + ACTIVITY_DUE_HOURS * 60 * 60 * 1000)
}

/** Предел заголовка дела на портале. Меряем в байтах: кириллица весит вдвое. */
export const MAX_TITLE_BYTES = 255

/**
 * Попал ли хоть один оценённый раздел в САМЫЙ НИЖНИЙ свой диапазон.
 *
 * ⚠ Цвет берётся отсюда, а НЕ из среднего балла, и это прямое следствие правила проекта
 * «средний балл не выносится главной метрикой». Порог задаёт не наш код, а сам шаблон:
 * нижний диапазон — это то, что клиент назвал плохим у себя. Придумав свою границу, мы
 * покрасили бы дело вопреки тому, что клиент написал в анкете.
 *
 * Раздел без диапазонов ничего не решает: сказать про него «плохо» не на чем.
 *
 * ⚠ Балл НИЖЕ нижнего диапазона — тоже «плохо», а не «ничего». У перенесённых анкет
 * диапазоны бывают с дырой внизу (у `digital` они начинаются с 4), а пропуск с 28.09 входит
 * в балл низшей оценкой — и раздел из одних пропусков падал в непокрытый низ, где дело
 * оставалось зелёным. Хуже худшего диапазона — это всё ещё худшее. Нашёл `/code-review`
 * в PR #85.
 */
export function hasBadSection(template: SurveyTemplate, score: SurveyScore): boolean {
  const lowestByKey = new Map(
    template.sections
      .filter(section => section.bands.length > 0)
      .map(section => [section.key, [...section.bands].sort((a, b) => a.from - b.from)[0]!]),
  )

  return score.sections.some((section) => {
    const lowest = lowestByKey.get(section.key)
    // ⚠ Сравнение ПО ССЫЛКЕ, а не по границе. `findBand` в `scoring.ts` отдаёт сам элемент
    // `section.bands`, а не копию, — значит тождество и есть точный ответ на вопрос
    // «тот ли это диапазон». Прежняя редакция сверяла `from`, и шаблон с двумя диапазонами
    // от одной границы (ручная правка, импорт из старого решения) красил дело красным вопреки
    // тому, что клиент написал в анкете. Нашла панель ревью PR #37–#39, issue #42.
    if (lowest === undefined || section.score === null) return false
    return section.band === lowest || (section.band === null && section.score < lowest.from)
  })
}

/** Начало заголовка дела с итогом. По нему переспрос узнаёт, что перезапись легла (`survey-activity.ts`). */
export const RESULT_TITLE_PREFIX = 'Опрос пройден: '

/**
 * Заголовок дела: что случилось и с каким итогом.
 *
 * ⚠ Название шаблона писал сотрудник портала — у него тот же уровень доверия, что у самой
 * CRM, — но обрезать его всё равно надо: длинное название заняло бы весь заголовок, и балла
 * в нём не осталось бы. Поэтому режется именно название, а итог приписывается после.
 */
export function buildActivityTitle(template: SurveyTemplate, score: SurveyScore): string {
  const prefix = RESULT_TITLE_PREFIX
  const tail = score.overall === null ? '' : ` — ${format(score.overall)}`

  // ⚠ Режем НАЗВАНИЕ, а не готовую строку. Первая редакция склеивала всё и обрезала конец —
  // то есть при длинном названии молча отрезала ровно балл, ради которого заголовок и нужен.
  // Порог наступал уже примерно на ста двадцати кириллических символах названия: лимит
  // байтовый, а кириллица весит вдвое. Нашла панель ревью, воспроизведением.
  const budget = MAX_TITLE_BYTES - byteLength(prefix) - byteLength(tail)
  return `${prefix}${capTo(template.title, budget)}${tail}`
}

/** Балл в русской записи: запятая, а не точка. Та же форма, что в тексте записи. */
function format(score: number): string {
  return String(score).replace('.', ',')
}

/** Длина в байтах: границы размеров в этом проекте меряются в байтах, а не в символах. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Обрезать текст до бюджета в байтах.
 *
 * ⚠ Режем по КОДОВЫМ ТОЧКАМ, а не по единицам UTF-16. `slice` разрубает суррогатную пару
 * пополам, и наружу уходит одинокий суррогат — портал сохранит замену или SDK откажется
 * кодировать строку. Эмодзи в названии анкеты — не экзотика. Нашла панель ревью.
 */
export function capTo(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text

  const points = [...text]
  let out = ''
  for (const point of points) {
    if (byteLength(out + point) > maxBytes) break
    out += point
  }
  return out
}

/** Обрезать заголовок целиком под предел портала. */
export function capTitle(title: string): string {
  return capTo(title, MAX_TITLE_BYTES)
}

/**
 * Найти уже записанное дело по нашей метке.
 *
 * ⚠ ПО ВЛАДЕЛЬЦУ НЕ СУЖАЕМ, и это не забывчивость — сужать нельзя. Панель ревью
 * (issue #42, пункт 2) справедливо заметила, что сделка к этому моменту известна, а фильтр
 * без неё заставляет `crm.activity.list` смотреть дела всего портала. Но замер 24.09
 * показал, что `crm.activity.binding.add` ПЕРЕНОСИТ владельца дела на привязанную сущность:
 * у дела с удавшейся привязкой владелец — элемент «Опроса», у дела без неё — сделка.
 * Обе формы законны и существуют одновременно, так что сужение по любой из них теряло бы
 * половину. Пара `ORIGINATOR_ID` + `ORIGIN_ID` уникальна сама по себе и от владельца
 * не зависит — ею и ищем.
 */
export function buildFindActivityCall(originId: string): PortalCall {
  return {
    method: ACTIVITY_LIST_METHOD,
    params: {
      // ⚠ ПАРА обязательна. `crm.activity.list` вернёт любое дело портала, подходящее
      // под фильтр, и один `ORIGIN_ID` мог бы совпасть с делом, которое клиент завёл сам
      // или принёс другой поставщик, — тогда мы молча решили бы, что уже писали.
      filter: { ORIGINATOR_ID: ACTIVITY_ORIGINATOR_ID, ORIGIN_ID: originId },
      // Закрыто ли дело, чьё оно, как называется и что в нём написано — то, что решает перезапись
      // и отзыв (`FoundActivity`).
      select: ['ID', 'COMPLETED', 'OWNER_TYPE_ID', 'OWNER_ID', 'SUBJECT', 'DESCRIPTION'],
      order: { ID: 'ASC' },
    },
  }
}

/** An activity found by our marker, with what the next step decides on. */
export interface FoundActivity {
  id: string
  /**
   * Closed by a person — «Выполнено» in the timeline.
   *
   * ⚠ Решаем по этому полю, прочитанному ДО записи, а не по отказу записи. Документация обещает
   * на закрытое дело `CAN_NOT_UPDATE_COMPLETED_TODO`, а портал 29.09 ответил кодом `"0"`
   * и текстом про файлы («Операции с файлами для закрытого дела запрещены») — различать отказы
   * по коду здесь нечем.
   */
  completed: boolean
  /**
   * The owner as the portal names it.
   *
   * ⚠ После привязки к элементу «Опроса» владельцем становится он, а не сделка (замерено 24.09
   * и 29.09). `crm.activity.todo.update` принял и сделку, и элемент — обе привязки, — но
   * документация велит передавать ту сущность, «к которой привязано дело», и ровно её портал
   * здесь и называет. Передаём её, а не угадываем.
   */
  ownerTypeId: number
  ownerId: number
  /** The title — revoking keeps what came after our prefix. */
  subject: string
  /**
   * The description as stored.
   *
   * ⚠ Читается ради одного вопроса — правил ли дело выпуска человек (`isUntouchedIssueActivity`).
   * У дела итога здесь слова клиента: в журнал это поле не уходит никогда.
   */
  description: string
}

/** The first activity carrying our marker; `null` — none, or the answer is not a list of them. */
export function readFoundActivity(response: unknown): FoundActivity | null {
  const id = readFoundActivityId(response)
  if (id === null) return null
  const row = ((response as { result: unknown[] }).result[0] ?? {}) as Record<string, unknown>
  return {
    id,
    completed: row.COMPLETED === 'Y',
    ownerTypeId: positive(row.OWNER_TYPE_ID),
    ownerId: positive(row.OWNER_ID),
    subject: typeof row.SUBJECT === 'string' ? row.SUBJECT : '',
    description: typeof row.DESCRIPTION === 'string' ? row.DESCRIPTION : '',
  }
}

function positive(raw: unknown): number {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * Привязать дело ко второй сущности CRM.
 *
 * ⚠ ЗАЧЕМ. Дело создаётся владельцем-сделкой, чтобы попасть в её ленту и в список дел
 * ответственного. Но элемент «Опроса» — и есть запись о прохождении, и читать итог логично
 * прямо там: владелец открыл карточку «Опроса» и увидел пустой таймлайн с предложением
 * «создайте дело» (issue #44). Привязка это чинит, не трогая владельца.
 *
 * ⚠ Предел — 100 элементов CRM на одно дело. Нам нужна ОДНА дополнительная, запас не наш.
 */
export function buildBindActivityCall(activityId: string, entityTypeId: number, entityId: number): PortalCall {
  // ⚠ ПОСЛЕДНЯЯ ПРИВЯЗКА СТАНОВИТСЯ ВЛАДЕЛЬЦЕМ ДЕЛА. Замерено на живом портале 24.09,
  // в документации метода этого нет: после привязки `crm.activity.get` показывает владельцем
  // привязанную сущность, а по фильтру владельца прежней сущности дело уже не находится.
  // Поэтому наш поиск существующего идёт ПО МЕТКЕ (`ORIGINATOR_ID` + `ORIGIN_ID`), а не
  // по владельцу, — и менять это нельзя, иначе повторная доставка создаст второе дело.
  return { method: 'crm.activity.binding.add', params: { activityId: Number(activityId), entityTypeId, entityId } }
}

/** Какие привязки уже стоят на деле. */
export function buildListBindingsCall(activityId: string): PortalCall {
  return { method: 'crm.activity.binding.list', params: { activityId: Number(activityId) } }
}

/**
 * Прочитать уже стоящие привязки в виде ключей «тип:идентификатор».
 *
 * ⚠ ЧИТАЕМ ОБА НАПИСАНИЯ КЛЮЧЕЙ, и это не перестраховка. Сосед замерил на своём портале
 * ВЕРХНИЙ регистр (`ENTITY_TYPE_ID`/`ENTITY_ID`), а наш тестовый портал 24.09 отдал
 * camelCase (`entityTypeId`/`entityId`) — два измерения, два ответа. Разбор в `docs/PROCESS.md`.
 * Прочитав только одно написание, мы получили бы пустой набор, сочли привязку отсутствующей
 * и напоролись на `ACTIVITY_IS_ALREADY_BOUND` — отказ, который через SDK доезжает
 * локализованным текстом без кода, то есть неотличим от настоящего.
 *
 * Ошибка чтения у вызывающего = пустой набор: худшее, что случится, — «уже привязано».
 */
export function readBindingKeys(response: unknown): Set<string> {
  const rows = (response as { result?: unknown } | null)?.result
  const keys = new Set<string>()
  if (!Array.isArray(rows)) return keys

  for (const raw of rows) {
    const row = raw as Record<string, unknown>
    const type = Number(row.ENTITY_TYPE_ID ?? row.entityTypeId)
    const id = Number(row.ENTITY_ID ?? row.entityId)
    if (Number.isInteger(type) && Number.isInteger(id)) keys.add(bindingKey(type, id))
  }

  return keys
}

/** Ключ пары. Своя копия формата у вызывающего разошлась бы с этой молча. */
export function bindingKey(entityTypeId: number, entityId: number): string {
  return `${entityTypeId}:${entityId}`
}

/** Идентификатор найденного дела; `null` — такого ещё нет. */
export function readFoundActivityId(response: unknown): string | null {
  const result = (response as { result?: unknown } | null)?.result
  if (!Array.isArray(result) || result.length === 0) return null
  const row = result[0] as Record<string, unknown>
  return asActivityId(row?.ID ?? row?.id)
}

/** Что отправляем в `crm.activity.todo.add`. */
export interface TodoActivityParams {
  ownerTypeId: number
  ownerId: number
  deadline: string
  title: string
  description: string
  colorId?: string
  responsibleId?: number
}

/**
 * Собрать дело в ленте сделки — дело выпуска ссылки или новое дело итога.
 *
 * ⚠ Дело создаётся ОТКРЫТЫМ и закрытым не становится. `todo.add` открытое по умолчанию,
 * то есть это решение НЕ добавлять признак завершения — записанное здесь потому, что его
 * отсутствие иначе невидимо. Смысл: опрос — это не отчёт, а повод поговорить с клиентом;
 * закрытое дело читается как «сделано, смотреть нечего», и его никто не откроет.
 * Решение владельца, 21.09.
 *
 * ⚠ Текст описания собирают не здесь: у итога — `buildResultDescription` (`comment.ts`),
 * у дела выпуска — `buildIssueActivityDescription`. Один сборщик на одно содержимое.
 */
export function buildTodoActivityCall(params: {
  dealEntityTypeId: number
  dealId: number
  title: string
  description: string
  deadline: Date
  /**
   * Цвет итога — всегда (`ACTIVITY_COLOR_*`, почему — там). Не передан только у дела выпуска:
   * «Отправить опрос клиенту» — обычное дело менеджера, и цвет у него портальный, по умолчанию.
   * Перезапись итогом ставит свой цвет, так что неразличимость «не задан» и «жёлтый» здесь
   * ничего не прячет.
   */
  color?: string
  responsibleId?: number
}): PortalCall {
  const fields: TodoActivityParams = {
    ownerTypeId: params.dealEntityTypeId,
    ownerId: params.dealId,
    // ⚠ С ЧАСОВЫМ ПОЯСОМ. Первая редакция обрезала его (`slice(0, 19)`), потому что пример
    // в документации показан без зоны — и это стоило ровно того, чем пахло: `toISOString()`
    // даёт UTC, портал прочитал `04:22` как СВОЁ местное, и дело родилось просроченным
    // на три часа. Видно на живом портале: `CREATED 07:22:23+03:00`, `DEADLINE 04:22:23+03:00`.
    //
    // Пример на JS в той же документации передаёт `new Date().toISOString()` целиком —
    // то есть зона методом принимается. Момент времени должен быть однозначным: мы не знаем
    // часового пояса чужого портала и знать его не обязаны.
    deadline: params.deadline.toISOString(),
    title: params.title,
    description: params.description,
    ...(params.color === undefined ? {} : { colorId: params.color }),
    ...(params.responsibleId ? { responsibleId: params.responsibleId } : {}),
  }
  return { method: ACTIVITY_ADD_METHOD, params: fields as unknown as Record<string, unknown> }
}

/**
 * Идентификатор дела из ответа `crm.activity.todo.add` или `crm.activity.todo.update`.
 *
 * У обоих методов ответ один: `{result:{id}}` (документация; у `todo.update` замерено 29.09).
 *
 * ⚠ Две формы ответа принимаются намеренно: документация обещает `{result:{id}}`, но у соседа
 * часть порталов отвечала `{result: id}`. Ошибиться здесь молча: `null` читается как
 * «ничего не записано», метка не наносится, и следующая доставка пишет дело заново.
 */
export function readActivityId(response: unknown): string | null {
  const result = (response as { result?: unknown } | null)?.result
  if (result === undefined || result === null) return null
  return asActivityId(typeof result === 'object' ? (result as Record<string, unknown>).id : result)
}

function asActivityId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const id = String(raw)
  // Нечисловой идентификатор значит, что мы неправильно прочитали конверт. Приняв его
  // за настоящий, мы нанесли бы метку в пустоту и спрятали поломку за успешным вызовом.
  return /^\d+$/.test(id) ? id : null
}

/**
 * Нанести метку и тип описания — одним вызовом.
 *
 * ⚠ Два поля едут вместе не для красоты: это два отдельных обращения к порталу, если их
 * разделить, и каждое — ещё одно окно, в котором дело существует наполовину настроенным.
 *
 * ⚠ `crm.activity.update` помечен в документации как DEPRECATED, и это принято сознательно:
 * другого способа проставить `ORIGINATOR_ID`/`ORIGIN_ID` и `DESCRIPTION_TYPE` у дела,
 * созданного `todo.add`, нет — у самого `todo.add` таких параметров не существует. Сосед
 * живёт на этой паре в бою.
 */
export function buildActivityMarkerCall(activityId: string, originId: string): PortalCall {
  return {
    method: ACTIVITY_UPDATE_METHOD,
    params: {
      id: Number(activityId),
      fields: {
        DESCRIPTION_TYPE: DESCRIPTION_TYPE_BB,
        ORIGINATOR_ID: ACTIVITY_ORIGINATOR_ID,
        ORIGIN_ID: originId,
      },
    },
  }
}

/**
 * Приняла ли пометка.
 *
 * ⚠ Проверяем ОТВЕТ, а не факт отсутствия исключения. `crm.activity.update` документирован
 * как возвращающий булево: «Возвращает true если дело успешно изменено, иначе — false».
 * То есть двухсотый ответ с `false` — задокументированный путь отказа, и приняв его
 * за успех, мы оставили бы дело без метки: поиск его не найдёт никогда, а следующая
 * доставка создаст второе. Ровно эту проверку соседний `ensureDealRelation` уже делает
 * для `crm.type.update`; сюда тот же урок не донесли. Нашла панель ревью.
 */
export function readMarkApplied(response: unknown): boolean {
  return (response as { result?: unknown } | null)?.result === true
}

/**
 * Приняла ли привязка.
 *
 * ⚠ `crm.activity.binding.add` тоже документирован как возвращающий булево, и `false` двухсотым
 * ответом — задокументированный путь отказа. Не проверив его, журнал говорил бы «привязано»,
 * когда привязки нет. Нашёл программист в панели PR #102: у метки и блоков проверка уже стояла.
 * Обратное не доказывает ничего — к НЕСУЩЕСТВУЮЩЕЙ сущности портал отвечает `true` (замер соседа).
 */
export function readBindApplied(response: unknown): boolean {
  return readMarkApplied(response)
}

/** Начало заголовка дела выпуска. По нему отзыв узнаёт наш заголовок (`buildRevokedTitle`). */
export const ISSUE_TITLE_PREFIX = 'Отправить опрос клиенту: '

/** Начало заголовка дела, закрытого отзывом ссылки. */
export const REVOKED_TITLE_PREFIX = 'Ссылка отозвана: '

/**
 * Заголовок дела выпуска: «Отправить опрос клиенту: <анкета>».
 *
 * Режется название анкеты, а не готовая строка, — по той же причине, что у итога
 * (`buildActivityTitle`): заголовок должен остаться читаемым целиком.
 */
export function buildIssueActivityTitle(surveyTitle: string): string {
  const name = surveyTitle.trim() === '' ? 'Опрос' : surveyTitle
  return `${ISSUE_TITLE_PREFIX}${capTo(name, MAX_TITLE_BYTES - byteLength(ISSUE_TITLE_PREFIX))}`
}

/**
 * Описание дела выпуска: адрес анкеты и срок действия.
 *
 * ⚠ АДРЕС С ТОКЕНОМ — В ДЕЛЕ СДЕЛКИ, и это решение владельца (issue #84, п. 14 и 20):
 * «не страшный секрет». У нас по-прежнему лежит только хеш токена. Цена записана
 * в `docs/PROCESS.md`: ответить вместо клиента может любой, кто видит сделку. Заодно это второй
 * путь скопировать ссылку: текст дела в ленте выделяется и копируется без буфера обмена фрейма.
 *
 * ⚠ Адрес строим МЫ (`buildSurveyUrl`), в нём нет скобок и пробелов, поэтому обезвреживать
 * здесь нечего. Разметка — наша: жирная подпись.
 */
export function buildIssueActivityDescription(url: string, expiresAt: Date): string {
  return [
    ISSUE_DESCRIPTION_HEAD,
    url,
    '',
    `${ISSUE_EXPIRY_LEAD}${formatExpiryDay(expiresAt)}. Ответить по ней можно один раз.`,
    ISSUE_DESCRIPTION_TAIL,
  ].join('\n')
}

/**
 * Первая строка описания дела выпуска — наша, по ней и по последней дело узнаётся нетронутым.
 *
 * ⚠ ЭТИ СТРОКИ — ХРАНИМЫЙ ФОРМАТ, а не просто текст. По ним доставка и отзыв узнают дело выпуска
 * нетронутым (`isOurIssueDescription`), а дела живут до тридцати дней. Поменяв формулировку, все
 * выпущенные за это время дела сочтутся правлеными: итог пойдёт новым делом рядом, а отзыв оставит
 * в них адрес. Меняя — узнавайте и прежний вариант (`/review`, PR #102).
 */
const ISSUE_DESCRIPTION_HEAD = '[B]Адрес анкеты для клиента:[/B]'
const ISSUE_EXPIRY_LEAD = 'Действует до '
/**
 * Последняя строка: что будет с делом.
 *
 * ⚠ Обещание честное с обеих сторон: закрытое дело портал не перезаписывает, и итог тогда приходит
 * новым делом рядом (решение владельца, п. 14). Прежний текст «это дело сменится итогом» в этой
 * ветке был неправдой — нашёл `/review` в панели PR #102.
 */
const ISSUE_DESCRIPTION_TAIL = 'Пока дело открыто, ответ клиента заменит его итогом. Закроете раньше — итог придёт новым делом рядом.'

/**
 * Правил ли дело выпуска человек: заголовок и описание — ровно наши.
 *
 * ⚠ ПРАВЛЕННОЕ ДЕЛО НЕ ПЕРЕЗАПИСЫВАЕМ. Перезапись заменяет заголовок и описание целиком, и заметка
 * менеджера («отправил в мессенджер, обещал до пятницы») пропала бы без следа. Нашёл `/review`
 * в панели PR #102. Тронутое дело остаётся как есть, итог пишется новым делом рядом.
 *
 * Сверяем строение, а не текст целиком: адреса анкеты у доставки нет — у нас лежит только хеш токена.
 */
export function isUntouchedIssueActivity(found: FoundActivity): boolean {
  return found.subject.startsWith(ISSUE_TITLE_PREFIX) && isOurIssueDescription(found.description)
}

/**
 * Описание дела выпуска — ровно наше, построчно.
 *
 * Отдельно от заголовка — ради отзыва: он бережёт текст человека, а переименованный заголовок
 * сохраняет и так (`buildRevokedTitle`). Переименовали только заголовок — адрес из нашего описания
 * отзыв всё равно убирает (`/review`, PR #102).
 */
export function isOurIssueDescription(description: string): boolean {
  const lines = description.split(/\r?\n/)
  return lines.length === 5
    && lines[0] === ISSUE_DESCRIPTION_HEAD
    && /^https:\/\/\S+$/.test(lines[1]!)
    && lines[2] === ''
    && lines[3]!.startsWith(ISSUE_EXPIRY_LEAD)
    && lines[4] === ISSUE_DESCRIPTION_TAIL
}

/**
 * С каким сдвигом от UTC считается день окончания ссылки, часов.
 *
 * ⚠ Пояс чужого портала нам неизвестен, а текст дела портал не переводит. Берём UTC+3 — Минск
 * и Москва. Срок ссылки — тридцать дней, и часы в нём не важны. На краю суток у далёкого пояса
 * день может разойтись на один. Точный срок в поясе человека портал показывает сам: поле
 * «Ссылка действительна до» в карточке «Результата опросов».
 */
const EXPIRY_DAY_OFFSET_HOURS = 3

/** The day a link stops working, `ДД.ММ.ГГГГ`. */
export function formatExpiryDay(moment: Date): string {
  const day = new Date(moment.getTime() + EXPIRY_DAY_OFFSET_HOURS * 60 * 60 * 1000)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(day.getUTCDate())}.${two(day.getUTCMonth() + 1)}.${day.getUTCFullYear()}`
}

/** Whom a call about a found activity is addressed to: `entityTypeId` and `entityId` of one of its bindings. */
export interface ActivityOwner {
  entityTypeId: number
  entityId: number
}

/**
 * Владелец найденного дела — или сделка, если портал его не назвал.
 *
 * Сделка — законная замена: дело к ней привязано всегда, а `crm.activity.todo.update` принял её
 * и после того, как владельцем стал элемент «Опроса» (замерено 29.09).
 */
export function ownerOf(found: FoundActivity, dealId: number): ActivityOwner {
  return found.ownerTypeId > 0 && found.ownerId > 0
    ? { entityTypeId: found.ownerTypeId, entityId: found.ownerId }
    : { entityTypeId: DEAL_ENTITY_TYPE_ID, entityId: dealId }
}

/**
 * Перезаписать дело выпуска итогом опроса.
 *
 * ⚠ `deadline` обязателен в КАЖДОМ вызове `crm.activity.todo.update` (документация) — поэтому срок
 * задаётся и здесь, тем же правилом, что у нового дела итога (`activityDeadline`).
 *
 * ⚠ Метку и тип описания перезапись не трогает — замерено 29.09: после `todo.update`
 * у дела те же `ORIGINATOR_ID`, `ORIGIN_ID` и `DESCRIPTION_TYPE = 2`. Ключ итога ставит
 * следующий вызов (`buildActivityMarkerCall`).
 */
export function buildOverwriteActivityCall(activityId: string, owner: ActivityOwner, params: {
  title: string
  description: string
  deadline: Date
  color: string
  /**
   * Нынешний ответственный за элемент — тот же, что у нового дела итога.
   *
   * ⚠ Без него итог оставался бы на том, кто выпускал ссылку до тридцати дней назад, а новое дело
   * итога шло бы нынешнему ответственному: ответ клиента зависел бы от ветки (`/review`, PR #102).
   * Ноль — не передаём, портал оставит прежнего.
   */
  responsibleId: number
}): PortalCall {
  return {
    method: ACTIVITY_TODO_UPDATE_METHOD,
    params: {
      id: Number(activityId),
      ownerTypeId: owner.entityTypeId,
      ownerId: owner.entityId,
      deadline: params.deadline.toISOString(),
      title: params.title,
      description: params.description,
      colorId: params.color,
      ...(params.responsibleId > 0 ? { responsibleId: params.responsibleId } : {}),
    },
  }
}

/** Текст дела, закрытого отзывом. Адреса в нём нет: он больше не открывается. */
export function buildRevokedDescription(dealTabTitle: string): string {
  return `Ссылка на анкету отозвана и больше не открывается. Чтобы опросить клиента снова, выпустите новую ссылку во вкладке «${dealTabTitle}».`
}

/**
 * Заголовок дела, закрытого отзывом: наш префикс выпуска меняется на «Ссылка отозвана».
 *
 * ⚠ По НАШЕМУ заголовку, а не по названию анкеты: отзыв знает о ссылке номер элемента и код,
 * но не название. Заголовок, который менеджер успел переписать, сохраняется целиком
 * и получает префикс спереди — чужое не выбрасываем.
 */
export function buildRevokedTitle(subject: string): string {
  const rest = subject.startsWith(ISSUE_TITLE_PREFIX) ? subject.slice(ISSUE_TITLE_PREFIX.length) : subject
  return `${REVOKED_TITLE_PREFIX}${capTo(rest.trim() === '' ? 'Опрос' : rest, MAX_TITLE_BYTES - byteLength(REVOKED_TITLE_PREFIX))}`
}

/**
 * Отметить дело выполненным, не трогая текста и заголовка — дело выпуска, итог по которому ушёл
 * новым делом рядом (`writeResultActivity`).
 */
export function buildCompleteActivityCall(activityId: string): PortalCall {
  return { method: ACTIVITY_UPDATE_METHOD, params: { id: Number(activityId), fields: { COMPLETED: 'Y' } } }
}

/**
 * Закрыть дело выпуска при отзыве ссылки — одним вызовом: тема, текст без адреса и «выполнено».
 * Текст меняется, только если он наш (`isOurIssueDescription`): заметку человека отзыв не трогает.
 *
 * ⚠ ОДИН ВЫЗОВ, А НЕ ДВА, и это ради отсутствия полусостояния. `crm.activity.update` принимает
 * тему, описание и `COMPLETED` вместе — замерено 29.09. Двумя вызовами дело могло бы остаться
 * открытым с текстом «отозвана» или закрытым с живым на вид адресом.
 *
 * ⚠ `crm.activity.update` помечен устаревшим; принят сознательно, как у метки дела
 * (`buildActivityMarkerCall`): у `todo.update` признака «выполнено» нет вовсе.
 */
export function buildRevokedActivityCall(found: FoundActivity, dealTabTitle: string): PortalCall {
  return {
    method: ACTIVITY_UPDATE_METHOD,
    params: {
      id: Number(found.id),
      fields: {
        SUBJECT: buildRevokedTitle(found.subject),
        // ⚠ Описание, которое правил человек, не трогаем: заметка менеджера («клиент просил
        // перезвонить в пятницу») пропала бы без следа, а закрытое дело потом не поправить. Адрес
        // в нём остаётся, но отозван и не открывается (`/code-review`, замыкающий проход PR #102).
        ...(isOurIssueDescription(found.description)
          ? { DESCRIPTION: buildRevokedDescription(dealTabTitle), DESCRIPTION_TYPE: DESCRIPTION_TYPE_BB }
          : {}),
        COMPLETED: 'Y',
      },
    },
  }
}
