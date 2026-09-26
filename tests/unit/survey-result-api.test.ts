import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Обработчик виджета результата: `server/api/portal/survey-result.post.ts`.
 *
 * ⚠ Гвард под блокер тестировщика в панели ревью PR #80. Страница виджета тестировалась против
 * ПОДДЕЛКИ этого роута (`registerEndpoint`), а чистые функции — сами по себе. Сам обработчик
 * не выполнял ни один тест: отключённая проверка «чья карточка» (`if (false && …)`) проходила
 * весь набор зелёным. Здесь проверяется ПОСЛЕДОВАТЕЛЬНОСТЬ шагов и то, что уходит в журнал.
 *
 * Роут импортируется напрямую — помощники в нём импортированы явно (приём и его история —
 * в `api-catch-all.test.ts`). Сессия, портал, база и журнал подделаны: предмет проверки —
 * порядок и решения обработчика, а не они.
 */

const SECRET = 'Менеджер хамил, больше к вам не пойду'

const SURVEY = { entityTypeId: 1046, id: 8 }
const TEMPLATE_SP = { entityTypeId: 1044, id: 7 }

const SCHEMA = {
  code: 'brand',
  title: 'Бренд',
  sections: [{
    key: 'open',
    title: 'Открытые вопросы',
    scored: false,
    bands: [],
    questions: [{ key: 'q1', sourceKey: 'q1', title: 'Что улучшить?', type: 'text', weight: 0, scored: false }],
  }],
}

/** Что подделки успели увидеть за один запрос. */
interface Probe {
  accessChecks: unknown[][]
  appCalls: string[]
  cacheReads: number
  portalReads: number
  cached: unknown[][]
  info: unknown[]
  warned: string[]
}

let probe: Probe
let body: Record<string, unknown>
let refs: Record<string, unknown>
let access: unknown
let cached: unknown
let published: unknown[]

/** Элемент «Опрос», как его отдал бы портал, с нашими полями. */
function item(fields: Record<string, unknown>) {
  const own = Object.fromEntries(Object.entries(fields).map(([postfix, value]) => [`UF_CRM_${SURVEY.id}_${postfix}`, value]))
  return { id: 15, ...own }
}

async function loadHandler() {
  probe = { accessChecks: [], appCalls: [], cacheReads: 0, portalReads: 0, cached: [], info: [], warned: [] }

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
  vi.doMock('../../server/b24/read-templates', () => ({
    readAllPublishedTemplates: async () => {
      probe.portalReads += 1
      return published
    },
  }))
  vi.doMock('../../server/links/store', () => ({
    findTemplate: async () => {
      probe.cacheReads += 1
      return cached
    },
  }))
  vi.doMock('../../server/links/issue', () => ({
    cacheTemplate: async (...args: unknown[]) => void probe.cached.push(args),
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

  const { default: handler } = await import('../../server/api/portal/survey-result.post')
  return (handler as unknown as (event: unknown) => Promise<Record<string, unknown>>)
}

beforeEach(() => {
  body = { memberId: 'm', authId: 'фреймовый-токен', itemId: 15, entityId: 'CRM_8', entityTypeId: null }
  refs = { survey: SURVEY, template: TEMPLATE_SP, revision: 3 }
  access = { ok: true, item: item({ TEMPLATE_CODE: 'brand', TEMPLATE_VERSION: 2, ANSWERS: JSON.stringify({ q1: SECRET }), STATE: 'completed' }) }
  cached = SCHEMA
  published = []
})

afterEach(() => {
  for (const path of [
    '../../server/api/portal/-session',
    '../../server/b24/provision',
    '../../server/b24/frame-auth',
    '../../server/b24/read-templates',
    '../../server/links/store',
    '../../server/links/issue',
    '../../server/utils/logger',
    'h3',
  ]) vi.doUnmock(path)
  vi.resetModules()
})

describe('чья карточка — ДО чтения элемента', () => {
  it('ГЛАВНОЕ: поле на сделке не читает «Опрос» с тем же номером', async () => {
    // ⚠ Номер элемента в карточке сделки — номер сделки. Прочитав «Опрос» с тем же номером,
    // мы показали бы чужой результат, и выглядел бы он правдоподобно.
    body = { ...body, entityId: 'CRM_DEAL', entityTypeId: 2 }
    const handler = await loadHandler()

    const reply = await handler({})

    expect(reply).toEqual({ ok: false, reason: 'foreign-card' })
    expect(probe.accessChecks).toHaveLength(0)
  })

  it('без признаков карточки — отдельный отказ, и тоже без чтения', async () => {
    // На настоящей карточке «Опроса» это сбой встраивания: совет «удалите поле» здесь вреден.
    body = { ...body, entityId: '', entityTypeId: null }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'no-owner' })
    expect(probe.accessChecks).toHaveLength(0)
  })
})

describe('доступ решает портал', () => {
  it('элемент читается ТОКЕНОМ СОТРУДНИКА, а не приложения', async () => {
    // Токеном приложения мы показали бы и поля, закрытые от этого человека правами.
    const handler = await loadHandler()

    await handler({})

    expect(probe.accessChecks[0]).toEqual(['shef.bitrix24.ru', 'фреймовый-токен', SURVEY.entityTypeId, 15])
    expect(probe.appCalls).not.toContain('crm.item.get')
  })

  it('нет доступа — отказ без содержимого', async () => {
    access = { ok: false, reason: 'denied' }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'denied' })
  })

  it('портал недоступен — 503, а не «нет доступа»', async () => {
    access = { ok: false, reason: 'unreachable' }
    const handler = await loadHandler()

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })

  it('без смарт-процессов — отказ и строка в журнале', async () => {
    refs = { revision: 0 }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-provisioned' })
    expect(probe.warned.length).toBeGreaterThan(0)
    expect(probe.accessChecks).toHaveLength(0)
  })
})

describe('результат', () => {
  it('показывает вопросы словами, а в журнал пишет СКОЛЬКО, но не ЧТО', async () => {
    // ⚠ Инвариант проекта: текст ответа клиента не попадает в журнал ни в каком виде.
    const handler = await loadHandler()

    const reply = await handler({})

    expect(reply).toMatchObject({ ok: true, completed: true, title: 'Бренд', version: 2 })
    expect(JSON.stringify(reply)).toContain('Что улучшить?')
    expect(JSON.stringify(probe.info)).not.toContain(SECRET)
  })

  it('пока ответа нет — отдаёт состояние приглашения, чтобы не обещать невозможного', async () => {
    access = { ok: true, item: item({ TEMPLATE_CODE: 'brand', TEMPLATE_VERSION: 2, STATE: 'expired' }) }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: true, completed: false, state: 'expired' })
  })

  it('промах кэша: схема — с портала и обратно в кэш', async () => {
    // ⚠ Без записи обратно промах повторялся бы на каждом открытии карточки — до двадцати
    // вызовов в чужой портал за раз. Нашли безопасность, `/review` и `/code-review`.
    cached = null
    published = [{ code: 'brand', version: 2, title: 'Бренд', schema: SCHEMA }]
    const handler = await loadHandler()

    const reply = await handler({})

    expect(probe.portalReads).toBe(1)
    expect(probe.cached).toEqual([['портал', 'brand', 2, SCHEMA]])
    expect(reply).toMatchObject({ title: 'Бренд' })
  })

  it('пустая версия — это «версии нет», а не версия 0 и не перелистывание портала', async () => {
    // ⚠ `Number(null) === 0` проходит `Number.isInteger`: пустая версия превращалась в 0,
    // кэш промахивался, и на каждое открытие листались все шаблоны портала.
    access = { ok: true, item: item({ TEMPLATE_CODE: 'brand', TEMPLATE_VERSION: null, ANSWERS: JSON.stringify({ q1: 'да' }) }) }
    const handler = await loadHandler()

    const reply = await handler({})

    expect(reply).toMatchObject({ ok: true, completed: true, version: null })
    expect(probe.cacheReads).toBe(0)
    expect(probe.portalReads).toBe(0)
  })
})
