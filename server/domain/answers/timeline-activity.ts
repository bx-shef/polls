import type { SurveyTemplate } from '../surveys/model'
import { Buffer } from 'node:buffer'
import type { SurveyScore } from '../surveys/scoring'
import type { PortalCall } from '../portals/smart-processes'

/**
 * The timeline activity that carries a finished survey back into the deal.
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
 * Ключ дедупликации — элемент «Опрос», к которому относится ответ.
 *
 * Приглашение проходится ровно один раз (ссылка одноразовая, статус `completed` закрывает
 * её транзакцией), поэтому «один элемент — одно дело» и есть правильная единица.
 */
export function activityOriginId(itemId: number): string {
  return `survey-${itemId}`
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
 * второго вызова, у дела уже `DESCRIPTION_TYPE = 2`. То есть описание разбирается как BB-код
 * даже в окне между созданием и пометкой, и `neutralizeMarkup` нужен безусловно, а не
 * «на случай, если метка ляжет». Тип поля при этом `crm_enum_contenttype` — портал сам
 * объявляет его перечислением способов разобрать текст, и bbCode один из трёх.
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
    return lowest !== undefined && section.band !== null && section.band === lowest
  })
}

/**
 * Заголовок дела: что случилось и с каким итогом.
 *
 * ⚠ Название шаблона писал сотрудник портала — у него тот же уровень доверия, что у самой
 * CRM, — но обрезать его всё равно надо: длинное название заняло бы весь заголовок, и балла
 * в нём не осталось бы. Поэтому режется именно название, а итог приписывается после.
 */
export function buildActivityTitle(template: SurveyTemplate, score: SurveyScore): string {
  const prefix = 'Опрос пройден: '
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
      select: ['ID'],
      order: { ID: 'ASC' },
    },
  }
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
  colorId: string
  responsibleId?: number
}

/**
 * Собрать дело по завершённому опросу.
 *
 * ⚠ Дело создаётся ОТКРЫТЫМ и закрытым не становится. `todo.add` открытое по умолчанию,
 * то есть это решение НЕ добавлять признак завершения — записанное здесь потому, что его
 * отсутствие иначе невидимо. Смысл: опрос — это не отчёт, а повод поговорить с клиентом;
 * закрытое дело читается как «сделано, смотреть нечего», и его никто не откроет.
 * Решение владельца, 21.09.
 *
 * ⚠ Описание — целиком тот же текст, что собирал комментарий (`buildAnswerComment`).
 * Второй сборщик того же самого разошёлся бы с первым с первой правки.
 */
export function buildTodoActivityCall(params: {
  dealEntityTypeId: number
  dealId: number
  title: string
  description: string
  deadline: Date
  color: string
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
    colorId: params.color,
    ...(params.responsibleId ? { responsibleId: params.responsibleId } : {}),
  }
  return { method: ACTIVITY_ADD_METHOD, params: fields as unknown as Record<string, unknown> }
}

/**
 * Идентификатор созданного дела.
 *
 * ⚠ Две формы ответа принимаются намеренно: документация обещает `{result:{id}}`, но у соседа
 * часть порталов отвечала `{result: id}`. Ошибиться здесь молча: `null` читается как
 * «ничего не записано», метка не наносится, и следующая доставка пишет дело заново.
 */
export function readCreatedActivityId(response: unknown): string | null {
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
