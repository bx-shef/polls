import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Слышен ли отказ настроить связь со сделкой.
 *
 * ⚠ Отдельным файлом, потому что журнал подменяется модулем целиком — как в
 * `token-crypto-rotation-log.test.ts`, откуда приём и взят.
 *
 * ⚠ Заведён после `/code-review` PR #51: из трёх изменений того PR у этого не было гварда
 * вовсе. Удалив строку журнала, мы получили бы 629 зелёных тестов из 629 — ровно тот класс
 * отказа, который `CLAUDE.md` называет поимённо: «все тесты зелёными при живой регрессии».
 *
 * Цена молчания здесь названа в самом `provision.ts`: отказ читается как `dealLinked: false`,
 * неотличимо от «тариф не позволил», и владельца отправляют чинить тариф там, где виновата
 * чужая связь, которую мы не разобрали, — или где запись на самом деле прошла.
 */

const warn = vi.fn()
vi.mock('../../server/utils/logger', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }))

const SURVEY = { entityTypeId: 1046, id: 8 }

/** Связи в том виде, в каком их отдаёт живой портал. */
function relations(parent: unknown[], child: unknown[] = []) {
  return { result: { type: { relations: { parent, child } } } }
}

const GOOD = { entityTypeId: 2, isChildrenListEnabled: 'Y', isPredefined: 'N' }
const UNREADABLE = { entityTypeId: 177, isChildrenListEnabled: 'может быть' }

beforeEach(() => warn.mockClear())

describe('отказ настроить связь со сделкой слышен', () => {
  it('говорит, когда настройки не разобрались, и называет смарт-процесс', async () => {
    const { ensureDealRelation } = await import('../../server/b24/provision')
    const call = vi.fn(async () => relations([UNREADABLE]))

    expect(await ensureDealRelation(call, SURVEY)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![1]).toContain('не разобраны')
    // ⚠ Без `typeId` строка не привязывается ни к одному порталу на установщике,
    // который обслуживает много.
    expect(warn.mock.calls[0]![0]).toMatchObject({ typeId: SURVEY.id })
  })

  it('говорит, когда портал принял запись и не подтвердил её', async () => {
    // Второй отказ оставался молчащим, когда первый научился говорить.
    const { ensureDealRelation } = await import('../../server/b24/provision')
    const call = vi.fn(async (method: string) =>
      method === 'crm.type.update' ? relations([]) : relations([{ ...GOOD, isChildrenListEnabled: 'N' }]),
    )

    expect(await ensureDealRelation(call, SURVEY)).toBe(false)
    expect(warn.mock.calls[0]![1]).toContain('не подтвердил')
  })

  it('на здоровом портале молчит', async () => {
    // Предупреждение, которое звучит всегда, перестают читать.
    const { ensureDealRelation } = await import('../../server/b24/provision')
    const call = vi.fn(async () => relations([GOOD]))

    expect(await ensureDealRelation(call, SURVEY)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('в журнал не уходит ничего, кроме идентификатора типа', async () => {
    // ⚠ `typeId` — идентификатор СМАРТ-ПРОЦЕССА, а не клиента портала: запрет `CLAUDE.md`
    // его не касается. А вот содержимое чужих связей туда попасть не должно.
    const { ensureDealRelation } = await import('../../server/b24/provision')
    const call = vi.fn(async () => relations([{ entityTypeId: 177, isChildrenListEnabled: 'секрет клиента' }]))

    await ensureDealRelation(call, SURVEY)

    expect(JSON.stringify(warn.mock.calls)).not.toContain('секрет клиента')
  })
})
