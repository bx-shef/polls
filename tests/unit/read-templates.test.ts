import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAllPublishedTemplates } from '../../server/b24/read-templates'
import { logger } from '../../server/utils/logger'

/**
 * Чтение опубликованных шаблонов со штатными стадиями: `server/b24/read-templates.ts`.
 *
 * ⚠ Заведён в третьем круге панели PR #93. Администратор может выключить стадии у «Шаблона опроса»:
 * портал тогда прячет `stageId`, и выпуск решает одна дата публикации — версия, снятая с публикации
 * стадией, снова предлагается к выпуску. Это осознанный размен («выпуск работает» против «выпуск
 * молча встал целиком»), и держится здесь то, что он виден в журнале — с порталом и без шума.
 *
 * Предупреждение пишется раз за жизнь процесса на портал: у каждого теста свой домен, иначе
 * порядок тестов решал бы, кто из них увидит строку.
 */

const TEMPLATE = { entityTypeId: 1038, id: 8, categoryId: 14 }
const SCHEMA = JSON.stringify({ code: 'brand', title: 'Бренд', sections: [{ key: 's', title: 'Раздел', scored: false, bands: [], questions: [{ key: 'q', sourceKey: 'q', title: 'Вопрос', type: 'text', weight: 0, scored: false }] }] })
const version = (over: Record<string, unknown>) => ({ id: 4, UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: 1, UF_CRM_8_SCHEMA: SCHEMA, UF_CRM_8_PUBLISHED_AT: '2026-09-20', ...over })
const stageless = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(([, message]) => String(message).includes('выключены стадии'))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('опубликованные шаблоны со стадиями', () => {
  it('ГЛАВНОЕ: стадии выключены — выпуск решает дата, и это видно в журнале с порталом', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const call = vi.fn(async () => ({ result: { items: [version({})] } }))

    const found = await readAllPublishedTemplates(call, TEMPLATE, 'issuable', 'first.bitrix24.ru')

    expect(found.map(one => one.code)).toEqual(['brand'])
    // ⚠ С доменом: номер смарт-процесса у каждого портала свой и портала не называет. Нашёл
    // `/code-review` в панели PR #93.
    expect(stageless(warn).map(([context]) => context)).toEqual([{ domain: 'first.bitrix24.ru', typeId: 8 }])
  })

  it('ГЛАВНОЕ: одно предупреждение на портал, а не на каждое открытие вкладки', async () => {
    // Список читает каждое открытие вкладки сделки: строка на каждом открытии заглушила бы журнал.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const call = vi.fn(async () => ({ result: { items: [version({})] } }))

    await readAllPublishedTemplates(call, TEMPLATE, 'issuable', 'second.bitrix24.ru')
    await readAllPublishedTemplates(call, TEMPLATE, 'ever', 'second.bitrix24.ru')
    await readAllPublishedTemplates(call, TEMPLATE, 'issuable', 'third.bitrix24.ru')

    expect(stageless(warn).map(([context]) => (context as { domain: string }).domain)).toEqual(['second.bitrix24.ru', 'third.bitrix24.ru'])
  })

  it('ГЛАВНОЕ: список не дочитан — вкладка показывает, что есть, но журнал об этом знает, раз на портал', async () => {
    // С #110 листание заработало, и предел в двадцать страниц стал достижим: без строки в журнале анкеты
    // за ним пропадали бы из выпуска молча (`/review` и `/code-review` в PR #113).
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const call = vi.fn(async () => ({ result: { items: [version({ stageId: 'DT1038_14:SUCCESS' })] }, next: 50 }))

    const found = await readAllPublishedTemplates(call, TEMPLATE, 'issuable', 'fifth.bitrix24.ru')
    await readAllPublishedTemplates(call, TEMPLATE, 'issuable', 'fifth.bitrix24.ru')

    expect(found.length).toBeGreaterThan(0)
    const truncated = warn.mock.calls.filter(([, message]) => String(message).includes('не дочитан'))
    expect(truncated.map(([context]) => context)).toEqual([{ domain: 'fifth.bitrix24.ru', typeId: 8, pages: 20 }])
  })

  it('стадии на месте — молчит', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const call = vi.fn(async () => ({ result: { items: [version({ stageId: 'DT1038_14:SUCCESS' })] } }))

    expect((await readAllPublishedTemplates(call, TEMPLATE, 'issuable', 'fourth.bitrix24.ru')).map(one => one.code)).toEqual(['brand'])
    expect(warn).not.toHaveBeenCalled()
  })
})
