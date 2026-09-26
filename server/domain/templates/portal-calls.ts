import { buildFieldName } from '../portals/smart-processes'
import type { PortalCall, SmartProcessRef } from '../portals/smart-processes'
import { parseTemplateSchema } from '../invitations/portal-calls'
import type { SurveyTemplate } from '../surveys/model'

/**
 * Portal calls for the survey builder: reading one template element for editing.
 *
 * ⚠ ОТДЕЛЬНО ОТ `invitations/portal-calls.ts`, хотя читают те же поля. Тот модуль обслуживает
 * ВЫБОР анкеты: ему нужны только опубликованные, а всё остальное он молча пропускает —
 * показать в списке черновик значило бы дать выпустить ссылку на анкету, которой ещё нет.
 * Конструктору нужно ровно обратное: он открывает ЛЮБОЙ элемент, включая пустой черновик
 * и версию с испорченной схемой, — иначе чинить такую версию будет нечем. Один читатель
 * на две противоположные задачи пришлось бы разветвлять флагом, а флаг в чтении данных —
 * это два поведения под одним именем.
 */

/** Состояние шаблона: черновик правится, опубликованная версия неизменяема. */
export const TEMPLATE_STATE_DRAFT = 'draft'
export const TEMPLATE_STATE_PUBLISHED = 'published'

/** Шаблон, каким его открывает конструктор. */
export interface TemplateItem {
  id: number
  code: string
  version: number
  /** `draft` | `published` | что угодно ещё, что успели записать руками. */
  state: string
  /**
   * Когда портал последний раз менял элемент.
   *
   * ⚠ Нужно для защиты от одновременной правки: вкладка возвращает это значение вместе
   * со схемой, и запись отказывает, если оно разошлось. Без него две открытые вкладки молча
   * затирают работу друг друга, и обеим показано «Сохранено». Нашёл `/code-review`.
   *
   * Пусто — портал не отдал отметку. Тогда проверять нечем, и запись идёт как раньше:
   * отказывать из-за отсутствующего поля значило бы сломать сохранение целиком.
   */
  updatedAt: string
  /**
   * Разобранная схема либо `null`, если поле пустое или в нём не JSON.
   *
   * ⚠ `null` — это НЕ ошибка чтения, а законное состояние: элемент, созданный на портале
   * руками, приходит с пустым полем схемы. Конструктор обязан такой открыть и предложить
   * собрать анкету с нуля; отказавшись, он оставил бы человека наедине с пустой карточкой
   * и текстовым полем, в которое надо вписать JSON.
   */
  schema: SurveyTemplate | null
}

/**
 * Прочитать один элемент «Шаблона опроса».
 *
 * ⚠ `select: ['*']` и `useOriginalUfNames: 'Y'` — по той же причине, что у списка шаблонов:
 * с оригинальными именами портал honours в `select` только пользовательские поля, а системные
 * молча выбрасывает. Перечень полей здесь давал бы ответ без `id`. Замерено живьём, разбор
 * в `docs/PROCESS.md`.
 */
export function buildGetTemplateItemCall(template: SmartProcessRef, itemId: number): PortalCall {
  return {
    method: 'crm.item.get',
    params: {
      entityTypeId: template.entityTypeId,
      id: itemId,
      useOriginalUfNames: 'Y',
      select: ['*'],
    },
  }
}

/**
 * Разобрать ответ `crm.item.get` по шаблону.
 *
 * `null` — элемента нет либо ответ не той формы. Всё остальное отдаётся как есть, включая
 * пустой код и неразобранную схему: решает конструктор, а не читатель.
 */
export function readTemplateItem(response: unknown, template: SmartProcessRef): TemplateItem | null {
  const item = (response as { result?: { item?: unknown } } | null)?.result?.item
  if (item === null || typeof item !== 'object') return null

  const bag = item as Record<string, unknown>
  const id = Number(bag.id)
  if (!Number.isInteger(id) || id <= 0) return null

  const version = Number(bag[buildFieldName(template.id, 'VERSION')])

  return {
    id,
    code: asText(bag[buildFieldName(template.id, 'CODE')]),
    // Ноль, а не единица: «версии ещё нет» и «версия первая» — разные вещи, и подставив
    // единицу мы бы назвали черновик первой версией, которой никто не публиковал.
    version: Number.isInteger(version) && version > 0 ? version : 0,
    state: asText(bag[buildFieldName(template.id, 'STATE')]),
    updatedAt: asText(bag.updatedTime),
    schema: parseTemplateSchema(bag[buildFieldName(template.id, 'SCHEMA')]),
  }
}

function asText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Записать схему в черновик.
 *
 * ⚠ Название элемента пишется ТЕМ ЖЕ вызовом, что и схема. Заголовок карточки на портале
 * и название анкеты в схеме — одна и та же вещь для человека, и разойтись им нельзя:
 * в списке смарт-процесса он видит заголовок, а в ссылке, которую получит респондент, —
 * название из схемы.
 *
 * ⚠ Схема уезжает СТРОКОЙ: поле текстовое, и читаем мы его обратно тоже из строки. Отдав
 * объект, мы положились бы на то, что портал сериализует его так же, как мы ожидаем прочесть.
 * Тот же приём, что у создания шаблона переносом.
 */
export function buildSaveSchemaCall(
  template: SmartProcessRef,
  itemId: number,
  schema: SurveyTemplate,
): PortalCall {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: template.entityTypeId,
      id: itemId,
      useOriginalUfNames: 'Y',
      fields: {
        title: schema.title,
        [buildFieldName(template.id, 'CODE')]: schema.code,
        [buildFieldName(template.id, 'SCHEMA')]: JSON.stringify(schema),
      },
    },
  }
}
