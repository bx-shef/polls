import { describe, expect, it } from 'vitest'
import { parseTaskCrmBindings, taskToCrmContext } from '../src/bitrix24/task'

describe('parseTaskCrmBindings', () => {
  it('сделка/контакт/компания из crmItemIds', () => {
    expect(parseTaskCrmBindings(['D_6529', 'C_45', 'CO_12'])).toEqual({
      dealId: 6529,
      contactId: 45,
      companyId: 12
    })
  })
  it('берёт первую привязку каждого типа', () => {
    expect(parseTaskCrmBindings(['D_1', 'D_2'])).toEqual({ dealId: 1 })
  })
  it('лид (L_) и неизвестный префикс игнорируются', () => {
    expect(parseTaskCrmBindings(['L_7', 'X_9', 'D_3'])).toEqual({ dealId: 3 })
  })
  it('регистронезависим', () => {
    expect(parseTaskCrmBindings(['d_8'])).toEqual({ dealId: 8 })
  })
  it('мусор / не массив / нечисловой id → пусто', () => {
    expect(parseTaskCrmBindings('D_1')).toEqual({})
    expect(parseTaskCrmBindings(null)).toEqual({})
    expect(parseTaskCrmBindings([42, 'D_x', 'CO_'])).toEqual({})
  })
})

describe('taskToCrmContext', () => {
  it('v3: responsible.id/name + crmItemIds', () => {
    const ctx = taskToCrmContext({
      id: 3835,
      title: 'Задача',
      responsible: { id: '17', name: 'Саша Иванов' },
      crmItemIds: ['D_6529', 'CO_12']
    })
    expect(ctx).toEqual({ responsibleId: 17, responsibleName: 'Саша Иванов', dealId: 6529, companyId: 12 })
  })
  it('v2: responsibleId + ufCrmTask', () => {
    const ctx = taskToCrmContext({ responsibleId: 9, ufCrmTask: ['C_45'] })
    expect(ctx).toEqual({ responsibleId: 9, contactId: 45 })
  })
  it('UF_CRM_TASK (легаси верхним регистром поля)', () => {
    expect(taskToCrmContext({ UF_CRM_TASK: ['D_1'] })).toEqual({ dealId: 1 })
  })
  it('без привязок и ответственного → пустой контекст', () => {
    expect(taskToCrmContext({ id: 1, title: 'x' })).toEqual({})
  })
  it('пустое имя ответственного не попадает в контекст', () => {
    expect(taskToCrmContext({ responsible: { id: 3, name: '' } })).toEqual({ responsibleId: 3 })
  })
})
