import { describe, expect, it, vi } from 'vitest'
import { fetchCrmNames, withCrmNames } from '../src/bitrix24/crm-names'
import { enrichWithCrmNames, CRM_NAMES_DEADLINE_MS } from '../server/utils/crm-names'
import type { PortalClient, CallResult } from '../src/bitrix24/client'
import type { CrmContext } from '../src/domain/schema'

/**
 * Обогащение снимка именами (компания/направление/ответственный).
 *
 * ⚠️ До этого модуля имена жили ТОЛЬКО в демо-сиде, и на живом портале три среза дашборда из
 * четырёх показывали `#9`, `#0`, `#1` — читать их было нельзя. Правило простое: имена — снимок на
 * момент выписки, спрашиваются только там, где приглашение уже точно выписывается, и любая беда со
 * справочниками оставляет снимок как был (fail-open с видимой строкой).
 */
const CTX: CrmContext = { dealId: 7, dealCategoryId: 0, companyId: 9, responsibleId: 1 }

function portal(over: Partial<Record<string, unknown>> = {}, fail: string[] = []) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const make = vi.fn(async (opts: { method: string; params?: Record<string, unknown> }): Promise<CallResult> => {
    calls.push({ method: opts.method, params: opts.params ?? {} })
    if (fail.includes(opts.method)) throw new Error(`${opts.method} недоступен`)
    const byMethod: Record<string, unknown> = {
      'crm.company.get': { TITLE: 'ООО «Ромашка»' },
      'crm.dealcategory.default.get': { ID: 0, NAME: 'Общая воронка' },
      'crm.dealcategory.get': { ID: '1', NAME: 'Сервис' },
      'user.get': [{ NAME: 'Игорь', LAST_NAME: 'Шевчик', PERSONAL_BIRTHDAY: '1990-01-01', PERSONAL_PHOTO: 'x' }],
      ...over
    }
    return { isSuccess: true, getData: () => ({ result: byMethod[opts.method], time: {} }), getErrorMessages: () => [] }
  })
  return { client: { actions: { v2: { call: { make } } } } as PortalClient, calls }
}

describe('fetchCrmNames', () => {
  it('приносит три имени; воронка 0 идёт ОТДЕЛЬНЫМ методом', async () => {
    // ⚠️ `crm.dealcategory.list` воронку 0 не возвращает (проверено вживую): у неё свой
    // `default.get`. Без ветки самый частый случай — портал с одной воронкой — остался бы без имени.
    const p = portal()
    const names = await fetchCrmNames(p.client, CTX)
    expect(names).toEqual({ companyName: 'ООО «Ромашка»', dealCategoryName: 'Общая воронка', responsibleName: 'Игорь Шевчик' })
    expect(p.calls.map((c) => c.method).sort())
      .toEqual(['crm.company.get', 'crm.dealcategory.default.get', 'user.get'])
  })

  it('ненулевая воронка — обычный get с id', async () => {
    const p = portal()
    const names = await fetchCrmNames(p.client, { ...CTX, dealCategoryId: 1 })
    expect(names.dealCategoryName).toBe('Сервис')
    expect(p.calls.find((c) => c.method === 'crm.dealcategory.get')?.params).toEqual({ id: 1 })
  })

  it('из user.get берутся ТОЛЬКО имя и фамилия — остальное ПДн сотрудника', async () => {
    const names = await fetchCrmNames(portal().client, CTX)
    expect(JSON.stringify(names)).not.toMatch(/BIRTHDAY|PHOTO|1990/)
  })

  it('отказ ОДНОГО справочника не топит остальные имена', async () => {
    const names = await fetchCrmNames(portal({}, ['crm.company.get']).client, CTX)
    expect(names.companyName).toBeUndefined()
    expect(names.dealCategoryName).toBe('Общая воронка')
    expect(names.responsibleName).toBe('Игорь Шевчик')
  })

  it('пустых запросов нет: id отсутствует → метод не зовётся', async () => {
    const p = portal()
    await fetchCrmNames(p.client, { dealId: 7 })
    expect(p.calls).toEqual([])
  })
})

describe('withCrmNames', () => {
  it('вливает имена, не трогая остальной снимок; пустые строки не создают полей', () => {
    const out = withCrmNames(CTX, { companyName: 'ООО «Ромашка»', dealCategoryName: '  ', responsibleName: undefined })
    expect(out.companyName).toBe('ООО «Ромашка»')
    expect('dealCategoryName' in out, 'пустая строка сломала бы фолбэк `#id` в срезе').toBe(false)
    expect(out.dealId).toBe(7)
  })

  it('имя длиннее капа схемы обрезается, а не роняет запись', () => {
    const out = withCrmNames(CTX, { companyName: 'а'.repeat(600) })
    expect(out.companyName?.length).toBe(500)
  })
})

describe('enrichWithCrmNames (проводка с дедлайном)', () => {
  const log = () => {
    const lines: Array<[string, Record<string, unknown>]> = []
    return { warn: (e: string, f: Record<string, unknown>) => { lines.push([e, f]) }, lines }
  }

  it('счастливый путь: снимок обогащён', async () => {
    const l = log()
    const out = await enrichWithCrmNames(portal().client, CTX, l)
    expect(out.companyName).toBe('ООО «Ромашка»')
    expect(l.lines).toEqual([])
  })

  it('справочники упали ВСЕ → снимок как был, отказ ВИДЕН строкой', async () => {
    const l = log()
    const out = await enrichWithCrmNames(
      portal({}, ['crm.company.get', 'crm.dealcategory.default.get', 'user.get']).client, CTX, l
    )
    expect(out).toEqual(CTX)
    // Частичный отказ — не строка (имена остальных пришли); полный — тоже не бросок. Строка пишется
    // только когда САМ запрос упал целиком — здесь each-ветки съели отказ, поэтому её нет.
    expect(l.lines).toEqual([])
  })

  it('портал ЗАВИС → выписка не ждёт дольше бюджета, отказ виден с reason: timeout', async () => {
    const hang: PortalClient = { actions: { v2: { call: { make: () => new Promise(() => { /* никогда */ }) } } } }
    const l = log()
    const started = Date.now()
    const out = await enrichWithCrmNames(hang, CTX, l)
    expect(Date.now() - started).toBeLessThan(CRM_NAMES_DEADLINE_MS + 1500)
    expect(out).toEqual(CTX)
    expect(l.lines[0]?.[0]).toBe('b24_crm_names_fail')
    expect(l.lines[0]?.[1].reason).toBe('timeout')
  }, 10_000)

  it('снимок без единого id (публичная ссылка) → к порталу не ходим вовсе', async () => {
    const p = portal()
    await enrichWithCrmNames(p.client, { dealId: 7 }, log())
    expect(p.calls).toEqual([])
  })
})
