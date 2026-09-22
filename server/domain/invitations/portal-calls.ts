import { buildFieldName, DEAL_ENTITY_TYPE_ID } from '../portals/smart-processes'
import type { PortalCall, SmartProcessRef } from '../portals/smart-processes'
import type { SurveyTemplate } from '../surveys/model'

/**
 * Portal calls for reading survey templates and creating an invitation item.
 *
 * Чистые билдеры: собрать вызов и разобрать ответ. Отправляет их интеграция — домен про REST
 * не знает.
 *
 * ⚠ Везде стоит `useOriginalUfNames: 'Y'`. По умолчанию `crm.item.*` работает с именами
 * пользовательских полей в camelCase (`ufCrm44_...`), а мы создавали их как `UF_CRM_<id>_CODE`.
 * Угадывать преобразование мы уже обжигались на `userfieldconfig.list` — там часть полей
 * не находилась НИКОГДА. Здесь портал сам предлагает работать оригинальными именами,
 * и это единственная форма, в которой мы уверены.
 */

// Константа живёт в `../portals/smart-processes.ts` — там же, где настраивается сама связь
// со сделкой. Здесь только повторный вывоз, чтобы у вызывающих не менялись импорты.
export { DEAL_ENTITY_TYPE_ID } from '../portals/smart-processes'

/** Состояние только что выпущенного приглашения. */
export const SURVEY_STATE_SENT = 'sent'

/**
 * Прочитать список опубликованных шаблонов.
 *
 * ⚠ `select: ['*']`, а не перечень полей, и это ИСПРАВЛЕНИЕ, а не упрощение. Прежняя редакция
 * перечисляла `id`, `title` и четыре наших поля — и не получала `id` с `title` НИКОГДА:
 * с `useOriginalUfNames: 'Y'` портал honours в `select` только оригинальные имена
 * пользовательских полей, а системные молча выбрасывает, в любом написании. Проверено
 * на живом портале, разбор в `docs/PROCESS.md`. Отсюда же мёртвая ветка в `firstFilled`
 * ниже: имя элемента как запасное название не срабатывало ни разу.
 *
 * Тяжелее ответ от этого не стал: схема и так была в перечне, а весит она больше всего
 * остального вместе взятого.
 */
export function buildListTemplatesCall(template: SmartProcessRef, start = 0): PortalCall {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: template.entityTypeId,
      useOriginalUfNames: 'Y',
      select: ['*'],
      ...(start === 0 ? {} : { start }),
    },
  }
}

/** Шаблон, каким его показывает вкладка: что выбрать и какую версию выпустить. */
export interface PublishedTemplate {
  code: string
  version: number
  title: string
  schema: SurveyTemplate
}

/**
 * Разобрать ответ со списком шаблонов.
 *
 * ⚠ Неопубликованные и нечитаемые пропускаются молча — это не потеря данных, а фильтр выбора:
 * показывать в списке черновик значило бы дать выпустить ссылку на анкету, которой ещё нет.
 * Схема, не разобравшаяся как JSON, — тот же случай: выпустить по ней ссылку значит выдать
 * человеку страницу, которая не откроется.
 */
export function readPublishedTemplates(response: unknown, template: SmartProcessRef): PublishedTemplate[] {
  const items = (response as { result?: { items?: unknown } } | null)?.result?.items
  if (!Array.isArray(items)) return []

  const codeField = buildFieldName(template.id, 'CODE')
  const versionField = buildFieldName(template.id, 'VERSION')
  const stateField = buildFieldName(template.id, 'STATE')
  const schemaField = buildFieldName(template.id, 'SCHEMA')
  const published: PublishedTemplate[] = []

  for (const raw of items) {
    const item = raw as Record<string, unknown>
    if (item[stateField] !== 'published') continue

    const code = typeof item[codeField] === 'string' ? item[codeField] : ''
    const version = Number(item[versionField])
    const schema = parseSchema(item[schemaField])
    if (code === '' || !Number.isInteger(version) || version <= 0 || schema === null) continue

    published.push({
      code,
      version,
      // ⚠ Заголовок берётся из СХЕМЫ, а не из имени элемента. Имя элемента пишет сотрудник
      // для себя, и на живом портале это оказался служебный код `demo` — он же уезжал
      // в название приглашения и в заголовок дела. Название анкеты живёт в схеме: его
      // видит респондент, оно и осмысленно. Имя элемента — запасной вариант.
      title: firstFilled(schema.title, item.title, code),
      schema,
    })
  }

  return published
}

/**
 * Создать элемент «Опрос» — само приглашение.
 *
 * ⚠ Приглашение и есть элемент смарт-процесса, а не запись у нас: источник истины — портал.
 * У нас остаётся только хеш токена в кэш-индексе, и по нему приглашение находится обратно.
 *
 * Связь со сделкой — поле `parentId<entityTypeId>`, то есть `parentId2`. Это не выдумка:
 * так устроены поля-родители у `crm.item.*`.
 */
export function buildCreateSurveyItemCall(
  survey: SmartProcessRef,
  dealId: number,
  invitation: {
    templateCode: string
    templateVersion: number
    expiresAt: Date
    title: string
    /** Клиент сделки на момент выпуска. Пусто — у сделки его не было или прочитать не вышло. */
    client?: Pick<DealFacts, 'contactId' | 'companyId'>
    /** Кто выпустил ссылку. Ноль — не знаем, портал поставит владельца токена. */
    assignedById?: number
  },
): PortalCall {
  return {
    method: 'crm.item.add',
    params: {
      entityTypeId: survey.entityTypeId,
      useOriginalUfNames: 'Y',
      fields: {
        title: invitation.title,
        [`parentId${DEAL_ENTITY_TYPE_ID}`]: dealId,
        // ⚠ Клиент проставляется СНИМКОМ на момент выпуска, а не вычисляется потом. У сделки
        // его могут поменять, и тогда «кого мы спрашивали» разошлось бы с «кто там сейчас».
        // Нули не шлём: портал понял бы их как «очистить», а не как «нет значения».
        ...(invitation.client?.contactId ? { contactId: invitation.client.contactId } : {}),
        ...(invitation.client?.companyId ? { companyId: invitation.client.companyId } : {}),
        // ⚠ Ответственный ставится ЯВНО. Элемент создаётся токеном ПРИЛОЖЕНИЯ, поэтому портал
        // проставил бы владельца токена — администратора, ставившего приложение, — а не того
        // сотрудника, который нажал «выпустить» и ждёт ответа. Дело по итогу опроса вешается
        // на ответственного элемента, то есть досталось бы не тому. Нашла панель ревью.
        ...(invitation.assignedById ? { assignedById: invitation.assignedById } : {}),
        [buildFieldName(survey.id, 'TEMPLATE_CODE')]: invitation.templateCode,
        [buildFieldName(survey.id, 'TEMPLATE_VERSION')]: invitation.templateVersion,
        [buildFieldName(survey.id, 'STATE')]: SURVEY_STATE_SENT,
        // Дата без времени: поле создавалось типом `date`, и портал отрежет время сам —
        // но лучше отдать то, что он ждёт, чем полагаться на его снисходительность.
        [buildFieldName(survey.id, 'EXPIRES_AT')]: invitation.expiresAt.toISOString().slice(0, 10),
      },
    },
  }
}

/** Идентификатор созданного элемента; `null`, если ответ не тот. */
export function readCreatedItemId(response: unknown): number | null {
  const id = Number((response as { result?: { item?: { id?: unknown } } } | null)?.result?.item?.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

function parseSchema(raw: unknown): SurveyTemplate | null {
  if (raw === null || typeof raw === 'object') {
    // Портал отдаёт текстовое поле строкой, но объект может прийти, если поле однажды
    // заведут структурным. Проверяем форму, а не тип поля.
    return isTemplateShaped(raw) ? raw as SurveyTemplate : null
  }
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return isTemplateShaped(parsed) ? parsed as SurveyTemplate : null
  }
  catch {
    return null
  }
}

/**
 * Проверить форму схемы, а не только её оболочку.
 *
 * ⚠ Сначала здесь проверялись только `code` и то, что `sections` — массив. Запись вида
 * `{"code":"x","sections":[{}]}` проходила фильтр, уезжала в кэш и доходила до публичной
 * страницы как «валидная» — где ломался бы рендер. Соседний комментарий при этом обещал,
 * что фильтр не даст выдать человеку страницу, которая не откроется. Нашла панель ревью PR #18.
 *
 * Проверяем структуру, а не содержимое: пустой список секций — законная анкета-заготовка,
 * а секция без `key` или с `questions` не массивом — уже поломка.
 */
function isTemplateShaped(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { code?: unknown, sections?: unknown }
  if (typeof candidate.code !== 'string' || candidate.code === '') return false
  if (!Array.isArray(candidate.sections)) return false

  return candidate.sections.every((raw) => {
    if (raw === null || typeof raw !== 'object') return false
    const section = raw as { key?: unknown, questions?: unknown }
    if (typeof section.key !== 'string' || section.key === '') return false
    if (!Array.isArray(section.questions)) return false

    return section.questions.every((item) => {
      if (item === null || typeof item !== 'object') return false
      const question = item as { key?: unknown, type?: unknown }
      return typeof question.key === 'string' && question.key !== '' && typeof question.type === 'string'
    })
  })
}

/** Что мы берём у сделки для приглашения. Ноль и пустая строка — значения нет. */
export interface DealFacts {
  contactId: number
  companyId: number
  title: string
}

/**
 * Прочитать клиента сделки, чтобы перенести его в приглашение.
 *
 * ⚠ Отдельный вызов, и он того стоит. Без клиента карточка «Опроса» отвечает на вопрос
 * «по какой сделке», но не отвечает на «кого мы, собственно, спрашивали», — а второе и есть
 * то, зачем менеджер её открывает.
 *
 * Спрашиваем только то, что переносим: имена полей подтверждены `crm.item.fields`
 * на живом портале (`CONTACT_ID`, `COMPANY_ID`; в `crm.item.*` — `contactId`, `companyId`).
 */
export function buildReadDealCall(dealId: number): PortalCall {
  // ⚠ Без `select`: у `crm.item.get` такого параметра НЕТ — документированы только
  // `entityTypeId`, `id` и `useOriginalUfNames`. Первая редакция его передавала, портал молча
  // игнорировал, а комментарий и тест рядом обещали «спрашиваем только то, что переносим» —
  // то есть гарантию, которой не существует. Нашла панель ревью. Нужна экономия — это
  // `crm.item.list`, у которого `select` есть.
  return { method: 'crm.item.get', params: { entityTypeId: DEAL_ENTITY_TYPE_ID, id: dealId } }
}

/**
 * Достать клиента из ответа.
 *
 * ⚠ Неудача — не ошибка выпуска. Ссылка важнее удобства карточки: отказать человеку
 * в выпуске из-за того, что не прочитался контакт, значит поменять местами главное
 * и второстепенное.
 */
export function readDealFacts(response: unknown): DealFacts {
  const item = (response as { result?: { item?: Record<string, unknown> } } | null)?.result?.item
  return {
    contactId: positive(item?.contactId),
    companyId: positive(item?.companyId),
    title: typeof item?.title === 'string' ? item.title.trim() : '',
  }
}

/** Первое непустое из перечисленного. */
function firstFilled(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/**
 * Название приглашения: анкета и сделка, по которой её выпустили.
 *
 * ⚠ Без сделки в названии карточка «Опроса» в списке смарт-процесса неразличима: двадцать
 * строк «Оценка работы по проекту» подряд не отвечают ни на один вопрос. Название сделки
 * написал сотрудник портала — доверие к нему то же, что к самой CRM.
 */
export function buildInvitationTitle(surveyTitle: string, dealTitle: string): string {
  const name = firstFilled(surveyTitle, 'Опрос')
  return dealTitle === '' ? name : `${name} — ${dealTitle}`
}

function positive(raw: unknown): number {
  const value = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(value) && value > 0 ? value : 0
}
