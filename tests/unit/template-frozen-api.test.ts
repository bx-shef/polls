import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Серверный запрет правки: `template-save.post.ts` и `template-publish.post.ts` со штатными стадиями.
 *
 * ⚠ Заведён тестировщиком панели PR #93. С ревизии 5 стадию шаблона двигают в канбане, а неизменяемость
 * решает дата публикации (`templateStateOf`, `isFrozen`). Проверял это только клиент — вкладка
 * против подделки роута, — а настоящая граница на сервере, и её не держал ни один тест. Здесь —
 * то, ради чего инвариант «опубликованная версия неизменяема» вообще заведён: снятая с публикации
 * и уведённая в «Черновик» версии не правятся и не публикуются повторно под новым номером.
 *
 * Здесь же — сверка отметки изменения при сохранении (#101): на уровне роута её не держал ни один тест.
 *
 * Роуты импортируются напрямую, сессия и портал подделаны — приём в `survey-result-api.test.ts`.
 */

const TEMPLATE = { entityTypeId: 1038, id: 8, categoryId: 14 }

const SCHEMA = {
  code: 'brand',
  title: 'Бренд',
  sections: [{
    key: 's1',
    title: 'Раздел',
    scored: true,
    bands: [{ from: 0, to: 10, text: 'Всё' }],
    questions: [{ key: 'q1', sourceKey: 'q1', title: 'Вопрос', type: 'scale', weight: 100, scored: true, scale: { min: 0, max: 10 } }],
  }],
}

let item: Record<string, unknown>
/** Элемент глазами сотрудника, если портал показывает ему не то, что приложению. `null` — то же самое. */
let userItem: Record<string, unknown> | null
let body: Record<string, unknown>
let writes: { method: string, params: Record<string, unknown> }[]

async function load(route: 'template-save' | 'template-publish') {
  writes = []
  vi.doMock('../../server/api/portal/-session', () => ({
    openPortalSession: async () => ({
      portal: { id: 'портал', domain: 'shef.bitrix24.ru' },
      userId: 3,
      authId: 'фреймовый-токен',
      call: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'crm.item.get') return { result: { item } }
        if (method === 'crm.item.list') return { result: { items: [item] } }
        writes.push({ method, params })
        return { result: { item: { id: 4 } } }
      },
    }),
  }))
  vi.doMock('../../server/b24/provision', () => ({ readStoredRefs: async () => ({ template: TEMPLATE }) }))
  vi.doMock('../../server/b24/frame-auth', () => ({ verifyItemAccess: async () => ({ ok: true, item: userItem ?? item }) }))
  vi.doMock('../../server/utils/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))
  vi.doMock('h3', async () => {
    const actual = await vi.importActual<typeof import('h3')>('h3')
    return { ...actual, readBody: async () => body }
  })
  vi.resetModules()

  // Пути — буквально: динамический импорт по шаблонной строке сборщик тестов не разбирает.
  const { default: handler } = route === 'template-save'
    ? await import('../../server/api/portal/template-save.post')
    : await import('../../server/api/portal/template-publish.post')
  return (handler as unknown as (event: unknown) => Promise<Record<string, unknown>>)
}

beforeEach(() => {
  userItem = null
  item = {
    id: 4,
    stageId: 'DT1038_14:SUCCESS',
    updatedTime: '2026-09-28T10:00:00+03:00',
    UF_CRM_8_CODE: 'brand',
    UF_CRM_8_VERSION: 1,
    UF_CRM_8_PUBLISHED_AT: '2026-09-20T03:00:00+03:00',
    UF_CRM_8_SCHEMA: JSON.stringify(SCHEMA),
  }
})

afterEach(() => {
  for (const path of [
    '../../server/api/portal/-session',
    '../../server/b24/provision',
    '../../server/b24/frame-auth',
    '../../server/utils/logger',
    'h3',
  ]) vi.doUnmock(path)
  vi.resetModules()
})

describe('сохранение схемы со стадиями', () => {
  beforeEach(() => {
    body = { itemId: 4, schema: SCHEMA }
  })

  it('ГЛАВНОЕ: снятую с публикации не правит', async () => {
    item = { ...item, stageId: 'DT1038_14:FAIL' }
    const save = await load('template-save')

    expect(await save({})).toEqual({ ok: false, reason: 'published' })
    expect(writes).toEqual([])
  })

  it('ГЛАВНОЕ: опубликованную, перетащенную в «Черновик», не правит — решает дата, а не стадия', async () => {
    item = { ...item, stageId: 'DT1038_14:NEW' }
    const save = await load('template-save')

    expect(await save({})).toEqual({ ok: false, reason: 'published' })
    expect(writes).toEqual([])
  })

  it('черновик, перетащенный в «Опубликован», остаётся правимым черновиком', async () => {
    // Даты нет — схему никто не проверял, и публикацией это не стало.
    item = { ...item, UF_CRM_8_PUBLISHED_AT: '' }
    const save = await load('template-save')

    expect(await save({})).toMatchObject({ ok: true })
    expect(writes.map(one => one.method)).toEqual(['crm.item.update'])
  })
})

describe('одновременная правка', () => {
  beforeEach(() => {
    item = { ...item, stageId: 'DT1038_14:NEW', UF_CRM_8_PUBLISHED_AT: '' }
  })

  it('ГЛАВНОЕ: отметка сверяется глазами сотрудника — тем же взглядом, каким её получила вкладка', async () => {
    // ⚠ Отметка приложения — чтение от имени другого пользователя, и совпадение записи времени
    // у двух токенов не замерено. Здесь они намеренно разные: сверка с приложением отказала бы.
    // `/review` в PR #104.
    userItem = { ...item, updatedTime: '2026-09-28T10:00:00+03:00' }
    item = { ...item, updatedTime: '2026-09-28T07:00:00+00:00' }
    body = { itemId: 4, schema: SCHEMA, updatedAt: '2026-09-28T10:00:00+03:00' }
    const save = await load('template-save')

    expect(await save({})).toMatchObject({ ok: true })
    expect(writes.map(one => one.method)).toEqual(['crm.item.update'])
  })

  it('отметка разошлась — отказ «stale» и ни одной записи', async () => {
    // Две вкладки на одной анкете иначе молча затирают работу друг друга. Нашёл `/code-review`.
    body = { itemId: 4, schema: SCHEMA, updatedAt: '2026-09-28T09:59:00+03:00' }
    const save = await load('template-save')

    expect(await save({})).toEqual({ ok: false, reason: 'stale' })
    expect(writes).toEqual([])
  })

  it('после записи вкладке уходит взгляд сотрудника — с его отметкой для следующей сверки', async () => {
    // Взгляд приложения показал бы ему поля мимо прав, а следующая сверка шла бы между двумя токенами.
    userItem = { ...item, updatedTime: '2026-09-28T10:05:00+03:00' }
    item = { ...item, updatedTime: '2026-09-28T07:05:00+00:00' }
    body = { itemId: 4, schema: SCHEMA }
    const save = await load('template-save')

    expect(await save({})).toMatchObject({ ok: true, template: { updatedAt: '2026-09-28T10:05:00+03:00' } })
  })
})

describe('поля, которые портал прячет от сотрудника', () => {
  /** Схема с дырой в диапазонах: публикация отказала бы проверкой и вернула бы претензии. */
  const BROKEN = { ...SCHEMA, sections: [{ ...SCHEMA.sections[0]!, title: 'Секретный раздел', bands: [{ from: 0, to: 5, text: 'Мало' }] }] }

  beforeEach(() => {
    item = { ...item, stageId: 'DT1038_14:NEW', UF_CRM_8_PUBLISHED_AT: '' }
    body = { itemId: 4, schema: SCHEMA }
  })

  it('ГЛАВНОЕ: запись не затирает схему, которой сотрудник не видел', async () => {
    // ⚠ Он видел пустой черновик и собрал анкету заново, а пишем мы токеном приложения — поверх
    // настоящей. Портал может и отдать поле пустым, поэтому сравниваются два взгляда. `/review` в PR #104.
    userItem = { ...item, UF_CRM_8_SCHEMA: null }
    const save = await load('template-save')

    expect(await save({})).toEqual({ ok: false, reason: 'hidden-fields' })
    expect(writes).toEqual([])
  })

  it('и тогда, когда портал не отдал поле вовсе', async () => {
    const { UF_CRM_8_SCHEMA: _hidden, ...rest } = item
    userItem = rest
    const save = await load('template-save')

    expect(await save({})).toEqual({ ok: false, reason: 'hidden-fields' })
    expect(writes).toEqual([])
  })

  it('пустой черновик, пустой для обоих, собирается с нуля как прежде', async () => {
    // Затирать нечего: схемы нет ни у сотрудника, ни у приложения.
    item = { ...item, UF_CRM_8_SCHEMA: '' }
    userItem = { ...item }
    const save = await load('template-save')

    expect(await save({})).toMatchObject({ ok: true })
    expect(writes.map(one => one.method)).toEqual(['crm.item.update'])
  })

  it('ГЛАВНОЕ: публикация не выпускает схему, которой сотрудник не видел, — и отказ не несёт её претензий', async () => {
    // ⚠ Выпуск необратим: номер занят, по версии выпускают ссылки. А отказ проверки отдал бы
    // названия разделов и формулировки вопросов из поля, которое портал закрыл. `/review`
    // и `/code-review` в PR #104.
    item = { ...item, UF_CRM_8_SCHEMA: JSON.stringify(BROKEN) }
    userItem = { ...item, UF_CRM_8_SCHEMA: null }
    body = { itemId: 4, action: 'publish' }
    const publish = await load('template-publish')

    const reply = await publish({})

    expect(reply).toEqual({ ok: false, reason: 'hidden-fields' })
    expect(JSON.stringify(reply)).not.toContain('Секретный раздел')
    expect(writes).toEqual([])
  })

  it('новую версию от спрятанной схемы тоже не заводит', async () => {
    item = { ...item, UF_CRM_8_PUBLISHED_AT: '2026-09-20T03:00:00+03:00', stageId: 'DT1038_14:SUCCESS' }
    const { UF_CRM_8_SCHEMA: _hidden, ...rest } = item
    userItem = rest
    body = { itemId: 4, action: 'new-version' }
    const publish = await load('template-publish')

    expect(await publish({})).toEqual({ ok: false, reason: 'hidden-fields' })
    expect(writes).toEqual([])
  })

  it('закрытая дата публикации — отказ, а не опубликованная версия под видом черновика', async () => {
    // Сотрудник увидел бы «Черновик» и кнопки правки, а сервер отвечал бы «уже опубликовали».
    item = { ...item, UF_CRM_8_PUBLISHED_AT: '2026-09-20T03:00:00+03:00', stageId: 'DT1038_14:SUCCESS' }
    userItem = { ...item, UF_CRM_8_PUBLISHED_AT: null }
    const save = await load('template-save')

    expect(await save({})).toEqual({ ok: false, reason: 'hidden-fields' })
    expect(writes).toEqual([])
  })
})

describe('публикация со стадиями', () => {
  beforeEach(() => {
    body = { itemId: 4, action: 'publish' }
  })

  it('ГЛАВНОЕ: снятую с публикации повторно не публикует — ни под старым номером, ни под новым', async () => {
    item = { ...item, stageId: 'DT1038_14:FAIL' }
    const publish = await load('template-publish')

    expect(await publish({})).toEqual({ ok: false, reason: 'published' })
    expect(writes).toEqual([])
  })

  it('от снятой с публикации можно открыть новую версию', async () => {
    item = { ...item, stageId: 'DT1038_14:FAIL' }
    body = { itemId: 4, action: 'new-version' }
    const publish = await load('template-publish')

    expect(await publish({})).toMatchObject({ ok: true, action: 'new-version' })
    const [created] = writes
    expect(created!.method).toBe('crm.item.add')
    expect((created!.params.fields as Record<string, unknown>).stageId).toBe('DT1038_14:NEW')
  })
})
