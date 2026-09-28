import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Обработчик списка анкет для вкладки сделки: `server/api/portal/surveys.post.ts`.
 *
 * ⚠ Урок панели ревью PR #80: вкладка тестируется против ПОДДЕЛКИ этого роута, а чистая функция
 * `surveyChoice` — сама по себе. Без этого файла то, что роут вообще ею пользуется, не проверял
 * бы никто: строка «версия 2 · 3 раздела · 8 вопросов» пропала бы из карточек молча.
 *
 * Сессия, портал и журнал подделаны: предмет проверки — что роут отдаёт наружу.
 */

const TEMPLATE_SP = { entityTypeId: 1044, id: 7 }

/** Опубликованный шаблон со схемой: два раздела, три вопроса. */
const PUBLISHED = {
  code: 'brand',
  version: 2,
  title: 'Бренд-платформа',
  schema: {
    code: 'brand',
    title: 'Бренд-платформа',
    sections: [
      {
        key: 'product',
        title: 'Продукт',
        scored: true,
        bands: [],
        questions: [
          { key: 'P1', sourceKey: 'P1', title: 'Насколько удобно?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
          { key: 'P2', sourceKey: 'P2', title: 'Насколько быстро?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
        ],
      },
      {
        key: 'open',
        title: 'Открытые вопросы',
        scored: false,
        bands: [],
        questions: [{ key: 'T1', sourceKey: 'T1', title: 'Что улучшить?', type: 'text', weight: 0, scored: false }],
      },
    ],
  },
}

let refs: Record<string, unknown>
let published: unknown[]
let warned: string[]

async function loadHandler() {
  warned = []
  vi.doMock('../../server/api/portal/-session', () => ({
    openPortalSession: async () => ({
      portal: { id: 'портал', domain: 'shef.bitrix24.ru' },
      userId: 3,
      userName: '',
      authId: 'фреймовый-токен',
      call: async () => ({ result: true }),
      batch: async () => ({}),
    }),
  }))
  vi.doMock('../../server/b24/provision', () => ({ readStoredRefs: async () => refs }))
  vi.doMock('../../server/b24/read-templates', () => ({ readAllPublishedTemplates: async () => published }))
  vi.doMock('../../server/utils/logger', () => ({
    logger: { info: () => {}, warn: (_fields: unknown, message: string) => void warned.push(message), error: () => {} },
  }))
  vi.resetModules()

  const { default: handler } = await import('../../server/api/portal/surveys.post')
  return (handler as unknown as (event: unknown) => Promise<Record<string, unknown>>)
}

beforeEach(() => {
  refs = { template: TEMPLATE_SP, revision: 3 }
  published = [PUBLISHED]
})

afterEach(() => {
  for (const path of [
    '../../server/api/portal/-session',
    '../../server/b24/provision',
    '../../server/b24/read-templates',
    '../../server/utils/logger',
  ]) vi.doUnmock(path)
  vi.resetModules()
})

describe('список анкет для вкладки сделки', () => {
  it('отдаёт у каждой анкеты число разделов и вопросов', async () => {
    const handler = await loadHandler()

    expect(await handler({})).toEqual({
      ok: true,
      surveys: [{ code: 'brand', version: 2, title: 'Бренд-платформа', sections: 2, questions: 3 }],
    })
  })

  it('схему наружу не отдаёт', async () => {
    // Схема весит больше всего остального ответа вместе взятого, а вкладке из неё нужны два числа.
    const handler = await loadHandler()

    expect(JSON.stringify(await handler({}))).not.toContain('Насколько удобно?')
  })

  it('без смарт-процессов — отказ и строка в журнале, а не пустой список', async () => {
    // Пустой список вкладка честно объясняет «опросов пока нет» — а здесь причина другая.
    refs = { revision: 0 }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-provisioned' })
    expect(warned).toHaveLength(1)
  })
})
