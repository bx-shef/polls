import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAllPublishedTemplates } from '../../server/b24/read-templates'
import { logger } from '../../server/utils/logger'

/**
 * Чтение опубликованных шаблонов со штатными стадиями: `server/b24/read-templates.ts`.
 *
 * ⚠ Заведён в третьем круге панели PR #93. Администратор может выключить стадии у «Шаблона опроса»:
 * портал тогда прячет `stageId`, и выпуск решает одна дата публикации — версия, снятая с публикации
 * стадией, снова предлагается к выпуску. Это осознанный размен («выпуск работает» против «выпуск
 * молча встал целиком»), и держится здесь то, что он виден в журнале.
 */

const TEMPLATE = { entityTypeId: 1038, id: 8, categoryId: 14 }
const SCHEMA = JSON.stringify({ code: 'brand', title: 'Бренд', sections: [{ key: 's', title: 'Раздел', scored: false, bands: [], questions: [{ key: 'q', sourceKey: 'q', title: 'Вопрос', type: 'text', weight: 0, scored: false }] }] })
const version = (over: Record<string, unknown>) => ({ id: 4, UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: 1, UF_CRM_8_SCHEMA: SCHEMA, UF_CRM_8_PUBLISHED_AT: '2026-09-20', ...over })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('опубликованные шаблоны со стадиями', () => {
  it('ГЛАВНОЕ: стадии выключены — выпуск решает дата, и это видно в журнале', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const call = vi.fn(async () => ({ result: { items: [version({})] } }))

    const found = await readAllPublishedTemplates(call, TEMPLATE)

    expect(found.map(one => one.code)).toEqual(['brand'])
    expect(warn.mock.calls.some(([, message]) => String(message).includes('выключены стадии'))).toBe(true)
  })

  it('стадии на месте — молчит', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const call = vi.fn(async () => ({ result: { items: [version({ stageId: 'DT1038_14:SUCCESS' })] } }))

    expect((await readAllPublishedTemplates(call, TEMPLATE)).map(one => one.code)).toEqual(['brand'])
    expect(warn).not.toHaveBeenCalled()
  })
})
