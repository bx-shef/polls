import { describe, expect, it } from 'vitest'
import { parseDealUpdateEvent, verifyApplicationToken, dealToCrmContext } from '../src/bitrix24/deal-event'

// Синтетическая фикстура формата события ONCRMDEALUPDATE (форма — как у Bitrix24; значения
// ЗАВЕДОМО ФЕЙКОВЫЕ, не реальный портал: домен `acme.*` — плейсхолдер, токены — маркеры `*-fake`).
// `event_handler_id`/`ts` парсер не читает — держим для верности реальной форме события.
const validRaw = {
  event: 'ONCRMDEALUPDATE',
  event_handler_id: '201',
  data: { FIELDS: { ID: '759' } },
  ts: '1736405807',
  auth: {
    member_id: 'member-id-fake-0000000000000000',
    domain: 'acme.bitrix24.ru',
    application_token: 'application-token-fake-0000000000',
    access_token: 'access-token-fake-00000000000000'
  }
}

describe('parseDealUpdateEvent — недоверенный POST события (#17)', () => {
  it('валидное событие → ID коэрсится в число, auth разобран', () => {
    const e = parseDealUpdateEvent(validRaw)
    expect(e?.data.FIELDS.ID).toBe(759)
    expect(e?.auth.member_id).toBe('member-id-fake-0000000000000000')
    expect(e?.auth.application_token).toBe('application-token-fake-0000000000')
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

  it('товарные позиции обогащают products (срез «услуга/товар» дашборда); пустой вход → без products', () => {
    // Формат PRODUCT_ID/PRODUCT_NAME сверен вебхуком (crm.deal.productrows.get).
    const rows = [
      { PRODUCT_ID: '13', PRODUCT_NAME: '[TEST] Внедрение' },
      { PRODUCT_ID: '0', PRODUCT_NAME: 'мусор' }, // 0 = не товар → отбрасывается
      { PRODUCT_ID: '20', PRODUCT_NAME: '' } // пустое имя → productName undefined
    ]
    const ctx = dealToCrmContext({ ID: '21', STAGE_ID: 'C1:NEW' }, rows)
    expect(ctx.products).toEqual([{ productId: 13, productName: '[TEST] Внедрение' }, { productId: 20 }])
    // Без строк — поле опущено (снимок чистый).
    expect(dealToCrmContext({ ID: '21' }).products).toBeUndefined()
    expect(dealToCrmContext({ ID: '21' }, []).products).toBeUndefined()
  })

  it('капы схемы усекаются в маппере (не роняют parse): >50 позиций → 50; длинное имя → 500', () => {
    // crmContextSchema.products .max(50) и productName .max(500) — валидация (throw), поэтому усекаем
    // в mapProductRows, иначе крупная B2B-сделка уронила бы parse → 502 на создании приглашения.
    const many = Array.from({ length: 60 }, (_, i) => ({ PRODUCT_ID: String(i + 1) }))
    const ctx = dealToCrmContext({ ID: '1' }, many)
    expect(ctx.products).toHaveLength(50)
    const longName = dealToCrmContext({ ID: '1' }, [{ PRODUCT_ID: '5', PRODUCT_NAME: 'x'.repeat(700) }])
    expect(longName.products?.[0]?.productName).toHaveLength(500)
  })

  it('мусорный/отрицательный/free-form PRODUCT_ID отброшен; дубли productId схлопнуты', () => {
    const rows = [
      { PRODUCT_ID: 'abc' }, // NaN → отброс
      { PRODUCT_ID: '-5' }, // отрицательный → отброс
      {}, // нет PRODUCT_ID → отброс
      { PRODUCT_ID: '0', PRODUCT_NAME: 'услуга без каталога' }, // free-form (0) → отброс
      { PRODUCT_ID: '13', PRODUCT_NAME: 'A' },
      { PRODUCT_ID: '13', PRODUCT_NAME: 'A (2-я строка, др. цена)' } // дубль → схлоп (byProduct не задвоит)
    ]
    expect(dealToCrmContext({ ID: '1' }, rows).products).toEqual([{ productId: 13, productName: 'A' }])
  })

  it('не-массив productRows → best-effort пусто (не throw)', () => {
    // @ts-expect-error — намеренно передаём не-массив (недоверенный REST мог вернуть не то)
    expect(dealToCrmContext({ ID: '1' }, { garbage: true }).products).toBeUndefined()
  })
})
