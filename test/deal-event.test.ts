import { describe, expect, it } from 'vitest'
import { parseDealUpdateEvent, verifyApplicationToken, dealToCrmContext } from '../src/bitrix24/deal-event'

const validRaw = {
  event: 'ONCRMDEALUPDATE',
  event_handler_id: '201',
  data: { FIELDS: { ID: '759' } },
  ts: '1736405807',
  auth: {
    member_id: 'a223c6b3710f85df22e9377d6c4f7553',
    domain: 'acme.bitrix24.ru',
    application_token: '51856fefc120afa4b628cc82d3935cce',
    access_token: 's6p6eclrvim6da22ft9ch94ekreb52lv'
  }
}

describe('parseDealUpdateEvent — недоверенный POST события (#17)', () => {
  it('валидное событие → ID коэрсится в число, auth разобран', () => {
    const e = parseDealUpdateEvent(validRaw)
    expect(e?.data.FIELDS.ID).toBe(759)
    expect(e?.auth.member_id).toBe('a223c6b3710f85df22e9377d6c4f7553')
    expect(e?.auth.application_token).toBe('51856fefc120afa4b628cc82d3935cce')
  })

  it('регистронезависимый event-код', () => {
    expect(parseDealUpdateEvent({ ...validRaw, event: 'OnCrmDealUpdate' })).not.toBeNull()
  })

  it('чужое событие / нет auth / нет ID / мусор → null', () => {
    expect(parseDealUpdateEvent({ ...validRaw, event: 'ONCRMDEALADD' })).toBeNull()
    expect(parseDealUpdateEvent({ ...validRaw, auth: undefined })).toBeNull()
    expect(parseDealUpdateEvent({ ...validRaw, auth: { ...validRaw.auth, application_token: '' } })).toBeNull()
    expect(parseDealUpdateEvent({ ...validRaw, data: { FIELDS: {} } })).toBeNull()
    expect(parseDealUpdateEvent({ ...validRaw, data: { FIELDS: { ID: '0' } } })).toBeNull() // не положительный
    expect(parseDealUpdateEvent('garbage')).toBeNull()
  })
})

describe('verifyApplicationToken — анти-форджери (#17)', () => {
  it('совпадение → true; расхождение/пустой → false', () => {
    expect(verifyApplicationToken('tok-abc', 'tok-abc')).toBe(true)
    expect(verifyApplicationToken('tok-abc', 'tok-xyz')).toBe(false)
    expect(verifyApplicationToken('tok-abc', 'tok-abc-longer')).toBe(false) // разная длина
    expect(verifyApplicationToken('', 'tok')).toBe(false)
    expect(verifyApplicationToken('tok', '')).toBe(false)
  })
})

describe('dealToCrmContext — crm.deal.get → снимок CrmContext (#17)', () => {
  it('IDs (строки REST) и стадия мапятся; 0 = «нет связи» → undefined', () => {
    const ctx = dealToCrmContext({
      ID: '759',
      CATEGORY_ID: '1',
      STAGE_ID: 'C1:WON',
      COMPANY_ID: '42',
      CONTACT_ID: '0', // нет контакта
      ASSIGNED_BY_ID: '7',
      OPPORTUNITY: '15000.50'
    })
    expect(ctx).toMatchObject({
      dealId: 759,
      dealCategoryId: 1,
      dealStageId: 'C1:WON',
      companyId: 42,
      responsibleId: 7,
      dealAmount: 15000.5
    })
    expect(ctx.contactId).toBeUndefined()
  })

  it('пустые/отсутствующие поля → undefined (без падения)', () => {
    const ctx = dealToCrmContext({ ID: '12', STAGE_ID: 'NEW' })
    expect(ctx.dealId).toBe(12)
    expect(ctx.dealStageId).toBe('NEW')
    expect(ctx.companyId).toBeUndefined()
    expect(ctx.dealAmount).toBeUndefined()
  })

  it('имена не выставляются (обогащение позже) — фолбэк на ID', () => {
    const ctx = dealToCrmContext({ ID: '5', COMPANY_ID: '9' })
    expect(ctx.companyName).toBeUndefined()
    expect(ctx.responsibleName).toBeUndefined()
  })
})
