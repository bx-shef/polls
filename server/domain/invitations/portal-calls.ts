import {
  buildFieldName,
  COMPANY_ENTITY_TYPE_ID,
  CONTACT_ENTITY_TYPE_ID,
  DEAL_ENTITY_TYPE_ID,
} from '../portals/smart-processes'
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
    const schema = parseTemplateSchema(item[schemaField])
    if (code === '' || !Number.isInteger(version) || version <= 0 || schema === null) continue

    published.push({
      code,
      version,
      // ⚠ Заголовок берётся ТОЛЬКО из схемы, и имя элемента запасным вариантом больше НЕ идёт.
      // Раньше шло — и не срабатывало ни разу, потому что `title` в ответе не приходил вовсе
      // (см. комментарий к `buildListTemplatesCall`). Починив `select`, мы бы эту ветку оживили,
      // и вот тогда она стала бы вредной: имя элемента правится на портале кем угодно и когда
      // угодно, а опубликованная версия обязана быть неизменяемой — сотрудник, переименовавший
      // карточку, задним числом поменял бы название версии, по которой уже собрана статистика.
      // Назвать анкету можно, но до публикации и через схему: `pnpm publish:templates`.
      // Нашёл `/code-review` в PR #50: мёртвую ветку нельзя оживлять, не решив, нужна ли она.
      title: firstFilled(schema.title, code),
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

/**
 * Разобрать схему анкеты из поля портала.
 *
 * ⚠ ЭКСПОРТИРУЕТСЯ, и это не про удобство. Публикация (`template-publish.ts`) решает по этой
 * же функции, можно ли выпускать версию. Своя, более слабая копия там уже была, и расхождение
 * стоило бы дорого в обе стороны: опубликованная схема, которую приложение потом отказывается
 * показывать, чинится только новой версией — а обратно, отказ публиковать схему, которую
 * приложение показывает прекрасно, выглядит как поломка переноса. Нашёл `/code-review` в PR #50.
 */
export function parseTemplateSchema(raw: unknown): SurveyTemplate | null {
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
 * Шапка анкеты: то, что респондент видит над вопросами. Пустая строка — данных нет,
 * и страница просто не рисует эту строку.
 *
 * Даты здесь НЕТ намеренно: момент выпуска — это `link_index.created_at`, и хранить его
 * второй раз значило бы завести два ответа на один вопрос. Названия анкеты тоже нет:
 * оно в схеме версии, то есть в кэше рядом.
 */
export interface SurveyHeader {
  /** Компания сделки — крупной строкой. */
  company: string
  /** Название сделки: проект, по которому спрашиваем. */
  project: string
  /** Контакт сделки: кого спрашиваем. */
  respondent: string
  /** Кто спрашивает: сотрудник, нажавший «выпустить». */
  manager: string
}

/**
 * Прочитать сделку, её компанию и её контакт — ОДНИМ обращением к порталу.
 *
 * ⚠ Пакет, а не три вызова, и это не про скорость, а про цену. Ссылку выпускают из карточки
 * сделки, то есть по нажатию кнопки: каждый лишний вызов — это и лимит портала клиента,
 * и секунда ожидания у сотрудника. Отдельными вызовами их было бы три, причём второй
 * и третий нельзя собрать, не дождавшись первого.
 *
 * ⚠ Компания и контакт адресуются ЧЕРЕЗ РЕЗУЛЬТАТ первой команды (`$result[deal][item][…]`) —
 * это штатная возможность `batch`, а не трюк. Она и позволяет уложиться в одно обращение:
 * иначе пришлось бы сходить за сделкой, узнать идентификаторы и сходить ещё раз.
 *
 * ⚠ Проверено на живом портале 23.09, потому что тут легко ошибиться на форме:
 * подстановка работает и в сыром виде, и percent-encoded (SDK кодирует её через `qs`);
 * при `halt: 0` упавшая команда уезжает в `result_error`, не мешая остальным; сделка
 * без компании даёт по этой команде `NOT_FOUND`, и это нормальный, ожидаемый исход.
 *
 * ⚠ Ключи команд — часть контракта с `readDealHeader` ниже. Менять их порознь нельзя.
 */
export function buildDealFactsBatch(dealId: number): Record<string, PortalCall> {
  return {
    // ⚠ Без `select`: у `crm.item.get` такого параметра НЕТ — документированы только
    // `entityTypeId`, `id` и `useOriginalUfNames`. Первая редакция его передавала, портал молча
    // игнорировал, а комментарий и тест рядом обещали «спрашиваем только то, что переносим» —
    // то есть гарантию, которой не существует. Нашла панель ревью. Нужна экономия — это
    // `crm.item.list`, у которого `select` есть.
    deal: { method: 'crm.item.get', params: { entityTypeId: DEAL_ENTITY_TYPE_ID, id: dealId } },
    company: {
      method: 'crm.item.get',
      params: { entityTypeId: COMPANY_ENTITY_TYPE_ID, id: '$result[deal][item][companyId]' },
    },
    contact: {
      method: 'crm.item.get',
      params: { entityTypeId: CONTACT_ENTITY_TYPE_ID, id: '$result[deal][item][contactId]' },
    },
  }
}

/**
 * Достать клиента из ответа пакета.
 *
 * ⚠ Неудача — не ошибка выпуска. Ссылка важнее удобства карточки: отказать человеку
 * в выпуске из-за того, что не прочитался контакт, значит поменять местами главное
 * и второстепенное.
 *
 * ⚠ Форма входа — карта УСПЕШНЫХ команд, где значение уже развёрнуто до `result` команды,
 * то есть `{ item: … }`. Это не то же самое, что ответ одиночного вызова (`{ result: { item } }`),
 * и перепутать их легко: разбор молча вернул бы пустоту.
 */
export function readDealFacts(batch: Record<string, unknown>): DealFacts {
  const item = itemOf(batch.deal)
  return {
    contactId: positive(item?.contactId),
    companyId: positive(item?.companyId),
    title: typeof item?.title === 'string' ? item.title.trim() : '',
  }
}

/**
 * Собрать шапку анкеты из ответа того же пакета.
 *
 * ⚠ Снимок на момент выпуска, а не ссылка на портал. Публичная страница о REST не знает
 * по инварианту, значит показать ей имя компании можно только тем, что мы сохранили сами.
 * Это же делает шапку честной задним числом: сделку переименуют, контакт заменят —
 * а человек отвечал на анкету, у которой в шапке стояло вот это.
 */
export function readSurveyHeader(batch: Record<string, unknown>, manager: string): SurveyHeader {
  const deal = itemOf(batch.deal)
  const company = itemOf(batch.company)
  const contact = itemOf(batch.contact)

  return {
    company: text(company?.title),
    project: text(deal?.title),
    // Порядок «имя, фамилия» — как у `profile` и как в карточке контакта. Отчество
    // намеренно мимо: шапка, а не паспорт.
    respondent: [text(contact?.name), text(contact?.lastName)].filter(part => part !== '').join(' '),
    // Не из портала: имя приходит из проверки фреймового токена (`profile`), которую
    // мы и так делаем на каждый запрос из карточки. Скоупа под `user.get` у приложения нет.
    manager: text(manager),
  }
}

/** Содержимое команды `crm.item.get` из пакета. Чужая структура — читаем защитно. */
function itemOf(raw: unknown): Record<string, unknown> | undefined {
  const item = (raw as { item?: unknown } | null | undefined)?.item
  return item !== null && typeof item === 'object' ? item as Record<string, unknown> : undefined
}

/** Строкой и без краевых пробелов; всё остальное — пусто. */
function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
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
