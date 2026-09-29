import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Чтение анкеты для вкладки конструктора: `server/api/portal/template.post.ts` (#101).
 *
 * По образцу `survey-form-api.test.ts`: роут импортируется напрямую, сессия, портал и журнал
 * подделаны. Предмет проверки — чьим токеном проверяется доступ, чей взгляд уходит наружу
 * и когда портал прячет от сотрудника поля конструктора.
 */

const TEMPLATE_SP = { entityTypeId: 1038, id: 8 }

function schemaTitled(title: string) {
  return {
    code: 'brand',
    title,
    sections: [{
      key: 'product',
      title: 'Продукт',
      scored: true,
      bands: [{ from: 0, to: 5, text: 'Плохо' }],
      questions: [
        { key: 'q1', sourceKey: 'q1', title: 'Насколько удобно?', type: 'scale', weight: 100, scored: true, scale: { min: 0, max: 10 } },
      ],
    }],
  }
}

/** Что подделки успели увидеть за один запрос. */
interface Probe {
  accessChecks: unknown[][]
  appCalls: string[]
  logged: string
}

let probe: Probe
let body: Record<string, unknown>
let refs: Record<string, unknown>
/** Элемент глазами сотрудника — ответ проверки доступа. */
let access: unknown
/** Тот же элемент глазами приложения. */
let appItem: Record<string, unknown>

async function loadHandler() {
  probe = { accessChecks: [], appCalls: [], logged: '' }

  vi.doMock('../../server/api/portal/-session', () => ({
    openPortalSession: async () => ({
      portal: { id: 'портал', domain: 'shef.bitrix24.ru' },
      userId: 3,
      userName: '',
      authId: 'фреймовый-токен',
      call: async (method: string) => {
        probe.appCalls.push(method)
        return { result: { item: appItem } }
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
  const log = (fields: unknown, message: string) => void (probe.logged += JSON.stringify(fields) + message)
  vi.doMock('../../server/utils/logger', () => ({ logger: { info: log, warn: log, error: log } }))
  vi.doMock('h3', async () => {
    const actual = await vi.importActual<typeof import('h3')>('h3')
    return { ...actual, readBody: async () => body }
  })
  vi.resetModules()

  const { default: handler } = await import('../../server/api/portal/template.post')
  return (handler as unknown as (event: unknown) => Promise<Record<string, unknown>>)
}

/** Черновик, каким его видят оба: все поля конструктора на месте. */
function draftWith(schemaTitle: string, updatedTime = '2026-09-29T10:00:00+03:00'): Record<string, unknown> {
  return {
    id: 42,
    updatedTime,
    UF_CRM_8_CODE: 'brand',
    UF_CRM_8_VERSION: 0,
    UF_CRM_8_PUBLISHED_AT: null,
    UF_CRM_8_SCHEMA: JSON.stringify(schemaTitled(schemaTitle)),
  }
}

beforeEach(() => {
  body = { memberId: 'm', authId: 'фреймовый-токен', itemId: 42 }
  refs = { template: TEMPLATE_SP, revision: 7 }
  appItem = draftWith('Бренд')
  access = { ok: true, item: draftWith('Бренд') }
})

afterEach(() => {
  for (const path of ['../../server/api/portal/-session', '../../server/b24/provision', '../../server/b24/frame-auth', '../../server/utils/logger', 'h3']) vi.doUnmock(path)
  vi.resetModules()
})

describe('чтение — глазами сотрудника', () => {
  it('ГЛАВНОЕ: доступ спрашивается ТОКЕНОМ СОТРУДНИКА, и наружу уходит ЕГО взгляд', async () => {
    // ⚠ Номер элемента присылает страница. Вызовом приложения — с правами администратора — любой
    // сотрудник прочитал бы любую анкету портала, включая черновики, мимо прав на сам элемент.
    // Нашла безопасность в панели PR #100 у поля «Анкета»; вкладка приведена к тому же в #101.
    // Взгляды здесь намеренно расходятся заголовком схемы: так видно, чей ушёл наружу.
    access = { ok: true, item: draftWith('Глазами сотрудника', '2026-09-29T10:00:00+03:00') }
    appItem = draftWith('Глазами приложения', '2026-09-29T07:00:00+00:00')
    const handler = await loadHandler()

    const reply = await handler({}) as { ok: boolean, template: { schema: { title: string }, updatedAt: string } }

    expect(probe.accessChecks).toEqual([['shef.bitrix24.ru', 'фреймовый-токен', TEMPLATE_SP.entityTypeId, 42]])
    expect(reply.ok).toBe(true)
    expect(reply.template.schema.title).toBe('Глазами сотрудника')
    expect(reply.template.updatedAt).toBe('2026-09-29T10:00:00+03:00')
  })

  it('не видит или элемента нет — отказ, и приложение элемент даже не читает', async () => {
    // Портал на удалённый элемент отвечает отказом, а не пустым ответом; различить их нечем.
    access = { ok: false, reason: 'denied' }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'denied' })
    expect(probe.appCalls).not.toContain('crm.item.get')
  })

  it('портал недоступен — 503, а не «нет доступа»', async () => {
    access = { ok: false, reason: 'unreachable' }
    const handler = await loadHandler()

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })

  it('ГЛАВНОЕ: поле конструктора портал сотруднику не отдал — отказ, а не пустой черновик', async () => {
    // ⚠ Пустой черновик пригласил бы собрать анкету заново, а запись идёт токеном приложения —
    // поверх настоящей схемы, которой сотрудник не видел. `/review` в PR #104.
    const { UF_CRM_8_SCHEMA: _hidden, ...rest } = draftWith('Бренд')
    access = { ok: true, item: rest }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'hidden-fields' })
    expect(probe.logged).toContain('поля анкеты не видны сотруднику')
  })

  it('и тогда, когда портал отдал его пустым', async () => {
    access = { ok: true, item: { ...draftWith('Бренд'), UF_CRM_8_SCHEMA: null } }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'hidden-fields' })
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

  it('без смарт-процессов — отказ и строка в журнале, без чтения', async () => {
    refs = { revision: 0 }
    const handler = await loadHandler()

    expect(await handler({})).toEqual({ ok: false, reason: 'not-provisioned' })
    expect(probe.logged).not.toBe('')
    expect(probe.accessChecks).toHaveLength(0)
  })
})

describe('что уходит наружу', () => {
  it('черновик со схемой — вместе с претензиями к ней', async () => {
    // Претензии считает сервер: `app/` не импортирует серверные модули.
    const handler = await loadHandler()

    const reply = await handler({}) as { ok: boolean, problems: { level: string }[] }

    expect(reply.ok).toBe(true)
    expect(reply.problems.some(problem => problem.level === 'error')).toBe(true)
  })

  it.each([null, ''])('черновик без схемы (%j у обоих) открывается пустым, а не отказом', async (empty) => {
    // Элемент, созданный на портале руками, приходит с пустым полем схемы — ключом со значением `null`
    // (замер 29.09). Его соберут во вкладке: затирать там нечего.
    access = { ok: true, item: { ...draftWith('Бренд'), UF_CRM_8_SCHEMA: empty } }
    appItem = { ...draftWith('Бренд'), UF_CRM_8_SCHEMA: empty }
    const handler = await loadHandler()

    expect(await handler({})).toMatchObject({ ok: true, template: { id: 42, schema: null }, problems: [] })
  })
})
