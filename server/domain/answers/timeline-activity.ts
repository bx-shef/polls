import type { SurveyTemplate } from '../surveys/model'
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
/** Метод, которым снимается дело, которое не удалось сделать находимым. */
export const ACTIVITY_DELETE_METHOD = 'crm.activity.delete'
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
 * `DESCRIPTION_TYPE = 1` — простой текст.
 *
 * ⚠ ЗНАЧЕНИЕ СНЯТО С ЖИВОГО ПОРТАЛА методом `crm.enum.contenttype`, который документация
 * прямо называет источником значений этого поля. Он отвечает: `1` — Plain text, `2` — bbCode,
 * `3` — HTML. Это НЕ совпадает с тем, что записано у соседа (`DESCRIPTION_TYPE_BB = 3`),
 * и расхождение важно: умолчание у дела — не простой текст, и не проставив тип, мы отдали бы
 * ответ постороннего человека на разбор как разметку.
 *
 * Простой текст выбран сознательно, а не за неимением лучшего. Комментарий к сделке уже
 * собирается плоским текстом (см. `comment.ts`) именно потому, что в него попадает то, что
 * набрал респондент, и строить из этого разметку значит отдать ему управление вёрсткой
 * записи в чужой CRM. С `DESCRIPTION_TYPE = 1` ни BB, ни HTML не разбираются вовсе —
 * обезвреживание скобок в `neutralizeMarkup` остаётся второй линией, а не единственной.
 *
 * ⚠ Тип нельзя задать при создании: у `crm.activity.todo.add` такого параметра нет.
 * Он едет тем же `crm.activity.update`, что и метка, — одним вызовом, а не двумя.
 */
export const DESCRIPTION_TYPE_PLAIN = 1

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

/** Предел заголовка дела. Портал считает символы, мы дополнительно смотрим на байты. */
export const MAX_TITLE_CHARS = 255
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
    return lowest !== undefined && section.band !== null && section.band.from === lowest.from
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
  const tail = score.overall === null ? '' : ` — ${String(score.overall).replace('.', ',')}`
  return capTitle(`Опрос пройден: ${template.title}${tail}`)
}

/**
 * Обрезать заголовок и по символам, и по байтам.
 *
 * ⚠ Два предела, а не один: портал считает символы, а правило проекта требует мерить байты,
 * потому что кириллица весит вдвое. Обрезав только по символам, мы отдали бы в поле на 255
 * строку в 500 байт.
 */
export function capTitle(title: string): string {
  let capped = title.slice(0, MAX_TITLE_CHARS)
  while (Buffer.byteLength(capped, 'utf8') > MAX_TITLE_BYTES) capped = capped.slice(0, -1)
  return capped
}

/** Найти уже записанное дело по нашей метке. */
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
    // ⚠ Без зоны и без миллисекунд: документация показывает `2025-02-03T15:00:00`,
    // а `WRONG_DATETIME_FORMAT` — один из заявленных отказов метода.
    deadline: params.deadline.toISOString().slice(0, 19),
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
        DESCRIPTION_TYPE: DESCRIPTION_TYPE_PLAIN,
        ORIGINATOR_ID: ACTIVITY_ORIGINATOR_ID,
        ORIGIN_ID: originId,
      },
    },
  }
}

/** Снять дело, которое не удалось сделать находимым. */
export function buildDeleteActivityCall(activityId: string): PortalCall {
  return { method: ACTIVITY_DELETE_METHOD, params: { id: Number(activityId) } }
}
