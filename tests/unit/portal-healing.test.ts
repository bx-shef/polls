import { describe, expect, it } from 'vitest'
import { PROVISION_STUCK_MINUTES, statusAfterProvision, stuckProvisioningBoundary } from '../../server/domain/portals/lifecycle'

/**
 * Политика долечивания порталов (issue #12) — чистые функции.
 *
 * ⚠ Обе живут в домене, а не рядом с запросом, по той же причине, что `purgeBoundary`:
 * SQL не должен знать про политику, а тест не должен подсовывать часы в базу.
 */

describe('исход обустройства → статус портала', () => {
  it('ГЛАВНОЕ: только `ok` делает портал рабочим', () => {
    // ⚠ Три отказа сводятся к одному статусу намеренно. `not-admin`, `no-scope` и `failed`
    // лечатся по-разному и по-разному объясняются человеку, но для нас все три означают
    // одно: приложение стоит и не работает. Отдельный статус под каждый был бы вторым
    // источником правды рядом с самим исходом.
    expect(statusAfterProvision('ok')).toBe('active')
    expect(statusAfterProvision('not-admin')).toBe('degraded')
    expect(statusAfterProvision('no-scope')).toBe('degraded')
    expect(statusAfterProvision('failed')).toBe('degraded')
  })
})

describe('граница брошенного обустройства', () => {
  it('отсчитывается назад от текущего момента', () => {
    const now = new Date('2026-09-25T12:00:00.000Z')

    expect(stuckProvisioningBoundary(now, 10).toISOString()).toBe('2026-09-25T11:50:00.000Z')
  })

  it('запас над бюджетом обустройства — больше чем десятикратный', () => {
    // ⚠ Бюджет всей цепочки — 45 секунд. Граница, поставленная близко к нему, отбирала бы
    // портал у живого обустройства, и два исполнителя пошли бы в чужой портал одновременно.
    // Десять минут — двенадцать бюджетов подряд; столько «долго идёт» не бывает, а вот
    // «процесс умер» выглядит именно так.
    expect(PROVISION_STUCK_MINUTES * 60).toBeGreaterThan(45 * 10)
  })
})
