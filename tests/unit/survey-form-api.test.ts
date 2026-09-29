import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Обработчик поля «Анкета»: `server/api/portal/survey-form.post.ts` (#84, п. 18).
 *
 * По образцу `survey-result-api.test.ts`: роут импортируется напрямую, сессия, портал и журнал
 * подделаны. Предмет проверки — порядок шагов (чья карточка — ДО чтения элемента), чьим токеном
 * читается элемент, что уходит наружу и что уходит в журнал.
 */

const SECRET_WORDING = 'Насколько вас раздражает наш менеджер?'

const TEMPLATE_SP = { entityTypeId: 1044, id: 7 }
const SURVEY = { entityTypeId: 1046, id: 8 }

const SCHEMA = {
  code: 'brand',
  title: 'Бренд',
  sections: [{
    key: 'product',
    title: 'Продукт',
    scored: true,
    bands: [{ from: 0, to: 10, text: 'Спасибо!' }],
    questions: [
      { key: 'q1', sourceKey: 'UF_Q1', title: SECRET_WORDING, type: 'scale', weight: 40, scored: true, scale: { min: 0, max: 10 } },
      { key: 'q2', sourceKey: 'UF_Q2', title: 'Когда удобно перезвонить?', type: 'date', weight: 0, scored: false },
    ],
  }],
}

/** Что подделки успели увидеть за один запрос. */
interface Probe {
  accessChecks: unknown[][]
  appCalls: string[]
  info: unknown[][]
  warned: string[]
}

let probe: Probe
let body: Record<string, unknown>
let refs: Record<string, unknown>
let access: unknown

async function loadHandler() {
  probe = { accessChecks: [], appCalls: [], info: [], warned: [] }

  vi.doMock('../../server/api/portal/-session', () => ({
    openPortalSession: async () => ({
      portal: { id: 'портал', domain: 'shef.bitrix24.ru' },
      userId: 3,
      userName: '',
      authId: 'фреймовый-токен',
      call: async (method: string) => {
        probe.appCalls.push(method)
        return { result: true }
      },
      batch: async () => ({}),
    }),
  }))
  vi.doMock('../../server/b24/provision', () => ({ readStoredRefs: async () => refs }))
  vi.doMock('../../server/b24/frame-auth', () => ({
    verifyItemAccess: async (...args: unknown[]) => {
      probe.accessChecks.push(args)
      return access
    },
  }))
  vi.doMock('../../server/utils/logger', () => ({
    logger: {
      info: (fields: unknown, message: string) => void probe.info.push([fields, message]),
      warn: (_fields: unknown, message: string) => void probe.warned.push(message),
      error: () => {},
    },
  }))
  vi.doMock('h3', async () => {
    const actual = await vi.importActual<typeof import('h3')>('h3')
    return { ...actual, readBody: async () => body }
  })
  vi.resetModules()

  const { default: handler } = await import('../../server/api/portal/survey-form.post')
  return (handler as unknown as (event: unknown) => Promise<Record<string, unknown>>)
}

beforeEach(() => {
  body = { memberId: 'm', authId: 'фреймовый-токен', itemId: 26, entityId: 'CRM_7', entityTypeId: null }
  refs = { survey: SURVEY, template: TEMPLATE_SP, revision: 7 }
  access = { ok: true, item: {
    id: 26,
    UF_CRM_7_CODE: 'brand',
    UF_CRM_7_VERSION: 3,
    UF_CRM_7_PUBLISHED_AT: '2026-09-21T10:00:00+03:00',
    UF_CRM_7_SCHEMA: JSON.stringify(SCHEMA),
  } }
})

afterEach(() => {
  for (const path of ['../../server/api/portal/-session', '../../server/b24/provision', '../../server/b24/frame-auth', '../../server/utils/logger', 'h3']) vi.doUnmock(path)
  vi.resetModules()
})

describe('чья карточка — ДО чтения элемента', () => {
  it('ГЛАВНОЕ: поле на сделке не читает «Шаблон» с тем же номером', async () => {
    // ⚠ Номер элемента в карточке сделки — номер сделки. Прочитав «Шаблон» с тем же номером,
    // мы показали бы в сделке чужую анкету, и выглядела бы она правдоподобно.
    body = { ...body, entityId: 'CRM_DEAL', entityTypeId: 2 }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'foreign-card' })
    expect(probe.accessChecks).toHaveLength(0)
  })

  it('поле на карточке «Результата опросов» — тоже чужая карточка', async () => {
    // Два наших смарт-процесса — два разных владельца: поле «Анкета» на «Результате» не читает «Шаблон».
    body = { ...body, entityId: `CRM_${SURVEY.id}` }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'foreign-card' })
    expect(probe.accessChecks).toHaveLength(0)
  })

  it('без признаков карточки — отдельный отказ, и тоже без чтения', async () => {
    body = { ...body, entityId: '', entityTypeId: null }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'no-owner' })
    expect(probe.accessChecks).toHaveLength(0)
  })

  it('узнаёт карточку и по типу объекта, когда `ENTITY_ID` не пришёл', async () => {
    body = { ...body, entityId: '', entityTypeId: TEMPLATE_SP.entityTypeId }
    const handler = await loadHandler()

    expect((await handler({})).ok).toBe(true)
  })
})

describe('чтение — токеном сотрудника', () => {
  it('ГЛАВНОЕ: элемент читается ТОКЕНОМ СОТРУДНИКА, а не приложения — права решает портал', async () => {
    // ⚠ Номер элемента присылает страница. Вызовом приложения — с правами администратора — любой
    // сотрудник прочитал бы любую анкету портала, включая черновики, мимо прав на сам элемент.
    // Нашла безопасность в панели PR #100.
    const handler = await loadHandler()

    await handler({})

    expect(probe.accessChecks).toEqual([['shef.bitrix24.ru', 'фреймовый-токен', TEMPLATE_SP.entityTypeId, 26]])
    expect(probe.appCalls).not.toContain('crm.item.get')
  })

  it('не видит или элемента нет — отказ без содержимого', async () => {
    // Портал на удалённый элемент отвечает отказом, а не пустым ответом; различить их нечем.
    // Прежде это был 500 и совет «обновите карточку», который не помогает (`/code-review`).
    access = { ok: false, reason: 'denied' }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'denied' })
  })

  it('портал недоступен — 503, а не «нет доступа»', async () => {
    access = { ok: false, reason: 'unreachable' }
    const handler = await loadHandler()

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })

  it.each<[Record<string, unknown>, string]>([
    [{ itemId: 0 }, 'ноль'],
    [{ itemId: '' }, 'пусто'],
    [{ itemId: 'abc' }, 'не число'],
  ])('без номера элемента — отказ без чтения (%#: %s)', async (patch) => {
    body = { ...body, ...patch }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'no-item' })
    expect(probe.accessChecks).toHaveLength(0)
  })

  it('без смарт-процессов — отказ и строка в журнале', async () => {
    refs = { revision: 0 }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-provisioned' })
    expect(probe.warned.length).toBeGreaterThan(0)
    expect(probe.accessChecks).toHaveLength(0)
  })
})

describe('что уходит наружу', () => {
  it('анкета словами: название, версия, разделы, вопросы и диапазоны', async () => {
    const handler = await loadHandler()

    const reply = await handler({}) as { ok: boolean, form: Record<string, unknown> }

    expect(reply.ok).toBe(true)
    expect(reply.form).toMatchObject({ code: 'brand', version: 3, title: 'Бренд' })
    expect(reply.form.sections).toEqual([{
      key: 'product',
      title: 'Продукт',
      scored: true,
      questions: [
        { key: 'q1', title: SECRET_WORDING, type: 'scale', scored: true, scale: { min: 0, max: 10 } },
        { key: 'q2', title: 'Когда удобно перезвонить?', type: 'date', scored: false, scale: null },
      ],
      bands: [{ from: 0, to: 10, text: 'Спасибо!' }],
    }])
  })

  it('веса и ключи источника наружу не уходят: человеку в карточке они ни о чём не говорят', async () => {
    const handler = await loadHandler()

    const reply = JSON.stringify(await handler({}))

    expect(reply).not.toContain('UF_Q1')
    expect(reply).not.toContain('"weight"')
  })

  it('черновик без схемы — пустая анкета с нулевой версией, а не отказ', async () => {
    // Свежий черновик законно пуст: его соберут во вкладке конструктора.
    access = { ok: true, item: { id: 26, UF_CRM_7_CODE: '', UF_CRM_7_VERSION: 0, UF_CRM_7_SCHEMA: '' } }
    const handler = await loadHandler()

    const reply = await handler({}) as { ok: boolean, form: Record<string, unknown> }

    expect(reply.ok).toBe(true)
    expect(reply.form).toMatchObject({ version: 0, title: '', sections: [] })
  })
})

describe('журнал', () => {
  it('ГЛАВНОЕ: в журнал — сколько, а не что: ни одной формулировки анкеты', async () => {
    // Формулировки — текст сотрудника клиента; журнал переживает инцидент и утекает вместе с ним.
    const handler = await loadHandler()

    await handler({})

    expect(probe.info).toEqual([[{ domain: 'shef.bitrix24.ru', sections: 1, questions: 2 }, 'анкета показана в карточке шаблона']])
    expect(JSON.stringify([probe.info, probe.warned])).not.toContain(SECRET_WORDING)
  })
})
