import { describe, expect, it } from 'vitest'
import {
  parseEntityUpdateEvent,
  entityToCrmContext,
  leadToCrmContext,
  spaItemToCrmContext,
  contactToCrmContext,
  companyToCrmContext,
  ENTITY_MAPPERS
} from '../src/bitrix24/entity-event'

const auth = { member_id: 'm1', domain: 'p.bitrix24.ru', application_token: 'tok' }

describe('parseEntityUpdateEvent — недоверенный POST → дескриптор сущности', () => {
  it('сделка/лид/контакт/компания → entityType + id', () => {
    for (const [event, entityType] of [
      ['ONCRMDEALUPDATE', 'deal'],
      ['ONCRMLEADUPDATE', 'lead'],
      ['ONCRMCONTACTUPDATE', 'contact'],
      ['ONCRMCOMPANYUPDATE', 'company']
    ] as const) {
      const r = parseEntityUpdateEvent({ event, data: { FIELDS: { ID: '759' } }, auth })
      expect(r).toMatchObject({ entityType, id: 759 })
    }
  })

  it('регистр события игнорируется', () => {
    expect(parseEntityUpdateEvent({ event: 'onCrmLeadUpdate', data: { FIELDS: { ID: 5 } }, auth })?.entityType).toBe('lead')
  })

  it('смарт-процесс: ENTITY_TYPE_ID → spaEntityTypeId; суффикс в имени события нормализуется', () => {
    const r = parseEntityUpdateEvent({ event: 'ONCRMDYNAMICITEMUPDATE_1056', data: { FIELDS: { ID: 7, ENTITY_TYPE_ID: 1056 } }, auth })
    expect(r).toMatchObject({ entityType: 'spa', id: 7, spaEntityTypeId: 1056 })
  })

  it('spa: spaEntityTypeId — fallback из суффикса имени, если нет ENTITY_TYPE_ID', () => {
    const r = parseEntityUpdateEvent({ event: 'ONCRMDYNAMICITEMUPDATE_1056', data: { FIELDS: { ID: 7 } }, auth })
    expect(r).toMatchObject({ entityType: 'spa', id: 7, spaEntityTypeId: 1056 })
  })

  it('spa без typeId (ни поля, ни суффикса) → spaEntityTypeId undefined', () => {
    expect(parseEntityUpdateEvent({ event: 'ONCRMDYNAMICITEMUPDATE', data: { FIELDS: { ID: 7 } }, auth })?.spaEntityTypeId).toBeUndefined()
  })

  it('ENTITY_TYPE_ID из FIELDS приоритетнее суффикса', () => {
    const r = parseEntityUpdateEvent({ event: 'ONCRMDYNAMICITEMUPDATE_1056', data: { FIELDS: { ID: 7, ENTITY_TYPE_ID: 2000 } }, auth })
    expect(r?.spaEntityTypeId).toBe(2000)
  })

  it('похожее-но-не-то имя (ONCRMDYNAMICITEMUPDATEX) → null', () => {
    expect(parseEntityUpdateEvent({ event: 'ONCRMDYNAMICITEMUPDATEX', data: { FIELDS: { ID: 1 } }, auth })).toBeNull()
  })

  it('неизвестное событие / мусор / нет id → null', () => {
    expect(parseEntityUpdateEvent({ event: 'ONCRMINVOICEUPDATE', data: { FIELDS: { ID: 1 } }, auth })).toBeNull()
    expect(parseEntityUpdateEvent({ event: 'ONCRMLEADUPDATE', data: { FIELDS: { ID: 0 } }, auth })).toBeNull()
    expect(parseEntityUpdateEvent({ event: 'ONCRMLEADUPDATE', data: {}, auth })).toBeNull()
    expect(parseEntityUpdateEvent(null)).toBeNull()
    // без auth доверять нечему
    expect(parseEntityUpdateEvent({ event: 'ONCRMLEADUPDATE', data: { FIELDS: { ID: 1 } } })).toBeNull()
  })

  it('spaEntityTypeId не подставляется для не-spa', () => {
    expect(parseEntityUpdateEvent({ event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: 1, ENTITY_TYPE_ID: 9 } }, auth })?.spaEntityTypeId).toBeUndefined()
  })
})

describe('мапперы сущность→CrmContext', () => {
  it('лид: STATUS_ID → триггер-ключ, связи/сумма', () => {
    const ctx = leadToCrmContext({ STATUS_ID: 'IN_PROCESS', COMPANY_ID: '101', CONTACT_ID: '0', ASSIGNED_BY_ID: '11', OPPORTUNITY: '5000' })
    expect(ctx).toMatchObject({ dealStageId: 'IN_PROCESS', companyId: 101, responsibleId: 11, dealAmount: 5000 })
    expect(ctx.contactId).toBeUndefined() // 0 = нет связи
  })

  it('смарт-процесс: camelCase-поля', () => {
    const ctx = spaItemToCrmContext({ stageId: 'DT1056:WON', companyId: 202, assignedById: 12, opportunity: 700 })
    expect(ctx).toMatchObject({ dealStageId: 'DT1056:WON', companyId: 202, responsibleId: 12, dealAmount: 700 })
  })

  it('стадия не строка (число из CRM) → dealStageId undefined', () => {
    expect(leadToCrmContext({ STATUS_ID: 123, COMPANY_ID: '1' }).dealStageId).toBeUndefined()
    expect(spaItemToCrmContext({ stageId: 5, companyId: 1 }).dealStageId).toBeUndefined()
  })

  it('пустой объект → все поля undefined (CrmContext gracefully пуст)', () => {
    expect(leadToCrmContext({})).toEqual({})
    expect(spaItemToCrmContext({})).toEqual({})
    expect(companyToCrmContext({})).toEqual({})
  })

  it('контакт/компания: сам как id, без стадии', () => {
    expect(contactToCrmContext({ ID: '777', COMPANY_ID: '101', ASSIGNED_BY_ID: '11' })).toMatchObject({ contactId: 777, companyId: 101, responsibleId: 11 })
    expect(contactToCrmContext({ ID: 777 }).dealStageId).toBeUndefined()
    expect(companyToCrmContext({ ID: '202', ASSIGNED_BY_ID: '12' })).toMatchObject({ companyId: 202, responsibleId: 12 })
  })

  it('ENTITY_MAPPERS покрывает все типы; deal/task без авто-маппинга', () => {
    expect(ENTITY_MAPPERS.deal).toBeNull()
    expect(ENTITY_MAPPERS.task).toBeNull()
    expect(typeof ENTITY_MAPPERS.lead).toBe('function')
    expect(typeof ENTITY_MAPPERS.spa).toBe('function')
    expect(typeof ENTITY_MAPPERS.contact).toBe('function')
    expect(typeof ENTITY_MAPPERS.company).toBe('function')
  })
})

describe('entityToCrmContext (диспетчер #34)', () => {
  it('deal → dealToCrmContext (STAGE_ID, числа-строки коэрцятся)', () => {
    const ctx = entityToCrmContext('deal', { ID: '5', STAGE_ID: 'WON', COMPANY_ID: '42' })
    expect(ctx).toMatchObject({ dealId: 5, dealStageId: 'WON', companyId: 42 })
  })
  it('lead → STATUS_ID в dealStageId', () => {
    expect(entityToCrmContext('lead', { STATUS_ID: 'CONVERTED' })).toMatchObject({ dealStageId: 'CONVERTED' })
  })
  it('spa → stageId в dealStageId', () => {
    expect(entityToCrmContext('spa', { stageId: 'DT1056:WON', companyId: 1 })).toMatchObject({ dealStageId: 'DT1056:WON', companyId: 1 })
  })
  it('contact/company → сам как id, без стадии', () => {
    expect(entityToCrmContext('contact', { ID: '7' })).toEqual({ contactId: 7 })
    expect(entityToCrmContext('company', { ID: '9' })).toEqual({ companyId: 9 })
  })
  it('task → бросает (вне CRM-пути)', () => {
    expect(() => entityToCrmContext('task', {})).toThrow()
  })
})
