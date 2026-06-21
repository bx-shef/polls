import { z } from 'zod'
import { crmContextSchema, ENTITY_TYPES, type CrmContext, type EntityType } from '../domain/schema'
import { num, posId } from './deal-event'

/**
 * Обобщённый триггер-биндинг CRM-событий (фаза мульти-сущность) — ЯДРО-рантайм, без HTTP/портала.
 * Расширяет `deal-event.ts` (ONCRMDEALUPDATE) на лид/смарт-процесс/контакт/компанию: парсит
 * недоверенный POST события обновления любой CRM-сущности и мапит её REST-поля в снимок `CrmContext`.
 *
 * Безопасность та же, что у deal-event: событие НЕДОВЕРЕННО (member_id/domain/application_token в
 * `auth`), верификация `application_token` — `verifyApplicationToken` (deal-event.ts), полные поля
 * сущности догружает binding-слой через `crm.<entity>.get(id)` токеном портала.
 *
 * NB про «стадию-триггер»: у сделки это `STAGE_ID`, у лида — `STATUS_ID`, у смарт-процесса — `stageId`,
 * у контакта/компании пайплайн-стадий НЕТ (их опросы запускаются вручную из карточки-виджета, не по
 * стадии). `CrmContext.dealStageId` исторически назван «deal», но фактически несёт СТРОКУ-триггер
 * любой сущности — `surveysTriggeredBy` матчит её по строке (портал-специфичные значения в
 * `invitationPolicy.triggerStages`). Переименование поля — отдельный рефактор (#next), чтобы не
 * ломать денормализацию/миграции; здесь оно используется как обобщённый «триггер-ключ».
 */

/** Имена событий обновления CRM-сущностей Bitrix24 → наш `EntityType`. */
const EVENT_TO_ENTITY: Record<string, EntityType> = {
  ONCRMDEALUPDATE: 'deal',
  ONCRMLEADUPDATE: 'lead',
  ONCRMCONTACTUPDATE: 'contact',
  ONCRMCOMPANYUPDATE: 'company'
  // spa (ONCRMDYNAMICITEMUPDATE[_<typeId>]) обрабатывается отдельно — у него суффикс с typeId.
}

/** Auth недоверенного POST (общий для всех событий). */
const eventAuthSchema = z.object({
  member_id: z.string().min(1).max(200),
  domain: z.string().min(1).max(253),
  application_token: z.string().min(1).max(200),
  // Битрикс кладёт access_token пользователя в событие; мапперы его НЕ читают (исходящие вызовы
  // идут токеном портала из PortalTokenStore). Пробрасываем транзитом — НЕ логировать (секрет).
  access_token: z.string().min(1).max(4096).optional()
})

const entityUpdateEventSchema = z.object({
  event: z.string().min(1).max(200),
  data: z.object({
    FIELDS: z.object({
      ID: z.coerce.number().int().positive(),
      // Только для ONCRMDYNAMICITEMUPDATE: id динамического типа (entityTypeId смарт-процесса).
      ENTITY_TYPE_ID: z.coerce.number().int().positive().optional()
    })
  }),
  auth: eventAuthSchema
})

export interface EntityUpdateEvent {
  entityType: EntityType
  id: number
  /**
   * entityTypeId смарт-процесса (только при entityType=spa). НЕДОВЕРЕННО до `verifyApplicationToken`:
   * это значение из POST-тела, и binding-слой обязан проверить `application_token` ПЕРЕД любым
   * `crm.item.get(spaEntityTypeId, id)` — иначе IDOR/cross-tenant (запрос чужого смарт-процесса).
   */
  spaEntityTypeId?: number
  auth: z.infer<typeof eventAuthSchema>
}

/**
 * Безопасно распарсить недоверенный POST события обновления ЛЮБОЙ CRM-сущности → `EntityUpdateEvent`
 * или `null` (мусор/неизвестное событие). Имя события сверяется регистронезависимо (наш контракт);
 * у спецсобытий смарт-процесса возможен суффикс (`ONCRMDYNAMICITEMUPDATE_1056`) — берём префикс.
 */
export function parseEntityUpdateEvent(raw: unknown): EntityUpdateEvent | null {
  const r = entityUpdateEventSchema.safeParse(raw)
  if (!r.success) return null
  const evt = r.data.event.toUpperCase()
  // Смарт-процесс шлёт `ONCRMDYNAMICITEMUPDATE_<typeId>` (точное имя ИЛИ с разделителем `_`,
  // не `ONCRMDYNAMICITEMUPDATEXXX`) — нормализуем к базовому имени.
  const isDynamic = evt === 'ONCRMDYNAMICITEMUPDATE' || evt.startsWith('ONCRMDYNAMICITEMUPDATE_')
  const entityType = isDynamic ? 'spa' : EVENT_TO_ENTITY[evt]
  if (!entityType) return null
  let spaEntityTypeId: number | undefined
  if (entityType === 'spa') {
    // typeId из FIELDS, иначе fallback из числового суффикса имени события (`..._1056` → 1056).
    const fromSuffix = isDynamic ? num(evt.slice('ONCRMDYNAMICITEMUPDATE_'.length)) : undefined
    spaEntityTypeId = r.data.data.FIELDS.ENTITY_TYPE_ID ?? (fromSuffix && fromSuffix > 0 ? fromSuffix : undefined)
  }
  return { entityType, id: r.data.data.FIELDS.ID, spaEntityTypeId, auth: r.data.auth }
}

/**
 * `crm.lead.get` → `CrmContext`. У лида нет категории/сделки; «стадия-триггер» = `STATUS_ID`
 * (кладём в `dealStageId` как обобщённый триггер-ключ, см. шапку). Сумма — `OPPORTUNITY`.
 */
export function leadToCrmContext(lead: Record<string, unknown>): CrmContext {
  return crmContextSchema.parse({
    dealStageId: typeof lead.STATUS_ID === 'string' ? lead.STATUS_ID : undefined,
    companyId: posId(lead.COMPANY_ID),
    contactId: posId(lead.CONTACT_ID),
    responsibleId: posId(lead.ASSIGNED_BY_ID),
    dealAmount: num(lead.OPPORTUNITY)
  })
}

/**
 * `crm.item.get` (смарт-процесс) → `CrmContext`. Поля динамических типов — в нижнем camelCase
 * (`stageId`/`assignedById`/`companyId`/`contactId`/`opportunity`). Стадия → обобщённый триггер-ключ.
 */
export function spaItemToCrmContext(item: Record<string, unknown>): CrmContext {
  return crmContextSchema.parse({
    dealStageId: typeof item.stageId === 'string' ? item.stageId : undefined,
    companyId: posId(item.companyId),
    contactId: posId(item.contactId),
    responsibleId: posId(item.assignedById),
    dealAmount: num(item.opportunity)
  })
}

/**
 * `crm.contact.get` / `crm.company.get` → `CrmContext`. У этих сущностей нет пайплайн-стадии
 * (опрос запускается вручную из виджета карточки, не по стадии): стадия-триггер не заполняется.
 * Контакт несёт себя как `contactId`, компания — как `companyId`; оба — `ASSIGNED_BY_ID`.
 */
export function contactToCrmContext(contact: Record<string, unknown>): CrmContext {
  return crmContextSchema.parse({
    contactId: posId(contact.ID),
    companyId: posId(contact.COMPANY_ID),
    responsibleId: posId(contact.ASSIGNED_BY_ID)
  })
}

/** `crm.company.get` → `CrmContext`. Компания несёт себя как `companyId`; пайплайн-стадии нет. */
export function companyToCrmContext(company: Record<string, unknown>): CrmContext {
  return crmContextSchema.parse({
    companyId: posId(company.ID),
    responsibleId: posId(company.ASSIGNED_BY_ID)
  })
}

/** Защита от рассинхрона: каждый EntityType имеет маппер ИЛИ помечен «без авто-маппинга». */
export const ENTITY_MAPPERS: Record<EntityType, ((f: Record<string, unknown>) => CrmContext) | null> = {
  deal: null, // в deal-event.ts (dealToCrmContext) — исторически отдельно
  lead: leadToCrmContext,
  spa: spaItemToCrmContext,
  contact: contactToCrmContext,
  company: companyToCrmContext,
  task: null // задача — вне CRM, отдельный binding (ONTASKUPDATE), не crm.*.get
}

// Страховка компиляции: ENTITY_MAPPERS покрывает ровно ENTITY_TYPES (рассинхрон → ошибка типов).
const _entityCoverage: Record<(typeof ENTITY_TYPES)[number], unknown> = ENTITY_MAPPERS
void _entityCoverage
