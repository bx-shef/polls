import { buildFieldName } from '../portals/smart-processes'
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

/** Идентификатор типа «Сделка». Системный, одинаковый на всех порталах. */
export const DEAL_ENTITY_TYPE_ID = 2

/** Состояние только что выпущенного приглашения. */
export const SURVEY_STATE_SENT = 'sent'

/**
 * Прочитать список опубликованных шаблонов.
 *
 * Берём только то, без чего нельзя показать выбор и выпустить ссылку: код, версию, состояние
 * и схему. Схема нужна потому же, почему нужна и дальше, — её кладут в кэш при выпуске,
 * и второй раз за ней в портал никто не пойдёт.
 */
export function buildListTemplatesCall(template: SmartProcessRef, start = 0): PortalCall {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: template.entityTypeId,
      useOriginalUfNames: 'Y',
      select: [
        'id',
        'title',
        buildFieldName(template.id, 'CODE'),
        buildFieldName(template.id, 'VERSION'),
        buildFieldName(template.id, 'STATE'),
        buildFieldName(template.id, 'SCHEMA'),
      ],
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
      title: typeof item.title === 'string' && item.title !== '' ? item.title : code,
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
  invitation: { templateCode: string, templateVersion: number, expiresAt: Date, title: string },
): PortalCall {
  return {
    method: 'crm.item.add',
    params: {
      entityTypeId: survey.entityTypeId,
      useOriginalUfNames: 'Y',
      fields: {
        title: invitation.title,
        [`parentId${DEAL_ENTITY_TYPE_ID}`]: dealId,
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

function isTemplateShaped(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { code?: unknown, sections?: unknown }
  return typeof candidate.code === 'string' && Array.isArray(candidate.sections)
}
