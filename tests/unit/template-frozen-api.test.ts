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
/** Что сотрудник увидит на следующих проверках доступа — перечитка после записи. `null` — то же, что первый раз. */
let userItemLater: Record<string, unknown> | null
let accessChecks: number
let body: Record<string, unknown>
let writes: { method: string, params: Record<string, unknown> }[]
/** Смещение следующей страницы в ответе списка шаблонов; `undefined` — страница последняя. */
let listNext: number | undefined
/** Страницы списка шаблонов по смещению `start`; `null` — одна страница с открытым элементом и `listNext`. */
let listPages: Record<number, { items: Record<string, unknown>[], next?: number }> | null
/** Что роут написал в журнал предупреждением. */
let warned: unknown[][]
/** Сколько страниц списка шаблонов роут прочитал. */
let listed: number

async function load(route: 'template-save' | 'template-publish') {
  writes = []
  vi.doMock('../../server/api/portal/-session', () => ({
    openPortalSession: async () => ({
      portal: { id: 'портал', domain: 'shef.bitrix24.ru' },
      userId: 3,
      authId: 'фреймовый-токен',
      call: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'crm.item.get') return { result: { item } }
        if (method === 'crm.item.list') listed += 1
        if (method === 'crm.item.list' && listPages !== null) {
          const page = listPages[Number(params.start ?? 0)] ?? { items: [] }
          return { result: { items: page.items }, ...(page.next === undefined ? {} : { next: page.next }) }
        }
        if (method === 'crm.item.list') return { result: { items: [item] }, ...(listNext === undefined ? {} : { next: listNext }) }
        writes.push({ method, params })
        return { result: { item: { id: 4 } } }
      },
    }),
  }))
  vi.doMock('../../server/b24/provision', () => ({ readStoredRefs: async () => ({ template: TEMPLATE }) }))
  vi.doMock('../../server/b24/frame-auth', () => ({
    verifyItemAccess: async () => {
      accessChecks += 1
      return { ok: true, item: accessChecks > 1 && userItemLater !== null ? userItemLater : (userItem ?? item) }
    },
  }))
  vi.doMock('../../server/utils/logger', () => ({ logger: { info: () => {}, warn: (...args: unknown[]) => warned.push(args), error: () => {} } }))
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
  listNext = undefined
  listPages = null
  warned = []
  listed = 0
  userItem = null
  userItemLater = null
  accessChecks = 0
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

  it('ГЛАВНОЕ: отметки двух взглядов в разных часовых поясах — не чужая правка', async () => {
    // ⚠ Вход читает элемент токеном сотрудника и токеном приложения — от имени двух пользователей,
    // и совпадение записи времени у двух токенов не замерено. Здесь пояса намеренно разные: сверка
    // строкой — и двух чтений, и отметки вкладки — отказала бы в каждом сохранении. `/review` в PR #104.
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

  it('ГЛАВНОЕ: после записи вкладке уходит СВЕЖАЯ перечитка глазами сотрудника — с новой отметкой', async () => {
    // Без перечитки вкладка осталась бы со старой отметкой, и каждое второе сохранение из неё упёрлось бы
    // в «stale». Взгляд приложения показал бы поля мимо прав. Отметка после записи здесь новая, поэтому
    // видно, что перечитка была. Второй замыкающий `/review` в PR #104.
    userItem = { ...item, updatedTime: '2026-09-28T10:00:00+03:00' }
    item = { ...item, updatedTime: '2026-09-28T07:00:00+00:00' }
    userItemLater = { ...userItem, updatedTime: '2026-09-28T10:05:00+03:00' }
    body = { itemId: 4, schema: SCHEMA, updatedAt: '2026-09-28T10:00:00+03:00' }
    const save = await load('template-save')

    expect(await save({})).toMatchObject({ ok: true, template: { updatedAt: '2026-09-28T10:05:00+03:00' } })
  })

  it('ГЛАВНОЕ: чужая запись между двумя чтениями входа — «stale», а не запись поверх', async () => {
    // Вкладка и сотрудник видят одну отметку, а к чтению приложения коллега уже сохранил своё. Сверка
    // одной отметки вкладки этого не видит. Второй замыкающий `/code-review` в PR #104.
    userItem = { ...item, updatedTime: '2026-09-28T10:00:00+03:00' }
    item = { ...item, updatedTime: '2026-09-28T10:00:02+03:00' }
    body = { itemId: 4, schema: SCHEMA, updatedAt: '2026-09-28T10:00:00+03:00' }
    const save = await load('template-save')

    expect(await save({})).toEqual({ ok: false, reason: 'stale' })
    expect(writes).toEqual([])
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

  it('закрытый номер версии не мешает: он прячет только значок «Версия N»', async () => {
    item = { ...item, UF_CRM_8_VERSION: 0 }
    userItem = { ...item, UF_CRM_8_VERSION: null }
    const save = await load('template-save')

    expect(await save({})).toMatchObject({ ok: true })
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

  it('ГЛАВНОЕ: публикация не выпускает редакцию, изменённую после открытия вкладки', async () => {
    // Коллега сохранил черновик из соседней вкладки, пока эта была открыта. Выпуск необратим — номер
    // занят, по версии выпускают ссылки. Второй замыкающий `/review` в PR #104.
    item = { ...item, stageId: 'DT1038_14:NEW', UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-28T10:05:00+03:00' }
    body = { itemId: 4, action: 'publish', updatedAt: '2026-09-28T10:00:00+03:00' }
    const publish = await load('template-publish')

    expect(await publish({})).toEqual({ ok: false, reason: 'stale' })
    expect(writes).toEqual([])
  })

  it('ГЛАВНОЕ: список шаблонов не дочитан — публикации нет, а не номер по неполному списку', async () => {
    // Выпуск необратим: номер, выданный по неполному списку, мог оказаться занятым, и две анкеты склеились бы
    // в одну пару «код + версия». С #110 листание заработало, и предел в двадцать страниц стал достижим
    // (`/review` и `/code-review` в PR #113).
    item = { ...item, stageId: 'DT1038_14:NEW', UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-28T10:05:00+03:00' }
    body = { itemId: 4, action: 'publish', updatedAt: '2026-09-28T10:05:00+03:00' }
    listNext = 50
    const publish = await load('template-publish')

    // ⚠ Отказ ответом, а не исключением: исключение уходило пятисотым, и вкладка звала его обрывом связи,
    // хотя повтор не поможет; своей строки с порталом в журнале не было (оба во втором круге PR #113).
    expect(await publish({})).toEqual({ ok: false, reason: 'list-truncated' })
    expect(writes).toEqual([])
    expect(warned).toEqual([[{ domain: 'shef.bitrix24.ru', action: 'publish', pages: 20 }, expect.stringContaining('не дочитан')]])
    // Прочитано ровно столько, сколько журнал называет (`/code-review` в третьем круге PR #113).
    expect(listed).toBe(20)
  })

  it('список не дочитан — новая версия не заводится: черновик мог лежать за пределом', async () => {
    body = { itemId: 4, action: 'new-version' }
    listNext = 50
    const publish = await load('template-publish')

    expect(await publish({})).toEqual({ ok: false, reason: 'list-truncated' })
    expect(writes).toEqual([])
    expect(warned).toEqual([[{ domain: 'shef.bitrix24.ru', action: 'new-version', pages: 20 }, expect.stringContaining('не дочитан')]])
    expect(listed).toBe(20)
  })

  it('ГЛАВНОЕ: версия со второй страницы учтена — номер следующий за ней, а не занятый', async () => {
    // Ради этого листание и заведено: отбор по коду идёт после ответа, и на пятьдесят первом шаблоне версии
    // уезжают на вторую страницу. Прежняя подделка отдавала одну и ту же страницу на любое смещение, и
    // положительного многостраничного случая здесь не было (`/code-review` во втором круге PR #113).
    item = { ...item, stageId: 'DT1038_14:NEW', UF_CRM_8_VERSION: '', UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-28T10:05:00+03:00' }
    body = { itemId: 4, action: 'publish', updatedAt: '2026-09-28T10:05:00+03:00' }
    const published = (id: number, version: number) => ({ id, stageId: 'DT1038_14:SUCCESS', UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: version, UF_CRM_8_PUBLISHED_AT: '2026-09-20T03:00:00+03:00' })
    listPages = { 0: { items: [item, published(3, 1)], next: 50 }, 50: { items: [published(5, 2)] } }
    const publish = await load('template-publish')

    expect(await publish({})).toEqual({ ok: true, action: 'publish', version: 3 })
  })

  it('версии обеих страниц учтены — номер следующий за наибольшей, где бы она ни лежала', async () => {
    // Наибольшая на первой странице: прочитав только вторую, роут выдал бы занятый номер (`/code-review`
    // в третьем круге PR #113 — прежний тест держал лишь одну сторону).
    item = { ...item, stageId: 'DT1038_14:NEW', UF_CRM_8_VERSION: '', UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-28T10:05:00+03:00' }
    body = { itemId: 4, action: 'publish', updatedAt: '2026-09-28T10:05:00+03:00' }
    const published = (id: number, version: number) => ({ id, stageId: 'DT1038_14:SUCCESS', UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: version, UF_CRM_8_PUBLISHED_AT: '2026-09-20T03:00:00+03:00' })
    listPages = { 0: { items: [item, published(3, 2)], next: 50 }, 50: { items: [published(5, 1)] } }
    const publish = await load('template-publish')

    expect(await publish({})).toEqual({ ok: true, action: 'publish', version: 3 })
  })

  it('ГЛАВНОЕ: черновик с первой страницы найден — новая версия его не дублирует', async () => {
    // Самый частый случай инварианта «перед созданием — поиск существующего»; на уровне роута его не держал
    // ни один тест (`/code-review` в третьем круге PR #113).
    body = { itemId: 4, action: 'new-version' }
    const draft = { id: 9, stageId: 'DT1038_14:NEW', UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: '', UF_CRM_8_PUBLISHED_AT: '' }
    listPages = { 0: { items: [item, draft] } }
    const publish = await load('template-publish')

    expect(await publish({})).toEqual({ ok: true, action: 'new-version', itemId: 9, entityTypeId: 1038, reused: true })
    expect(writes).toEqual([])
  })

  it('ГЛАВНОЕ: черновик со второй страницы найден — новая версия его не дублирует', async () => {
    body = { itemId: 4, action: 'new-version' }
    const draft = { id: 9, stageId: 'DT1038_14:NEW', UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: '', UF_CRM_8_PUBLISHED_AT: '' }
    listPages = { 0: { items: [item], next: 50 }, 50: { items: [draft] } }
    const publish = await load('template-publish')

    expect(await publish({})).toEqual({ ok: true, action: 'new-version', itemId: 9, entityTypeId: 1038, reused: true })
    expect(writes).toEqual([])
  })

  it('та же редакция, что во вкладке, публикуется', async () => {
    item = { ...item, stageId: 'DT1038_14:NEW', UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-28T10:05:00+03:00' }
    body = { itemId: 4, action: 'publish', updatedAt: '2026-09-28T10:05:00+03:00' }
    const publish = await load('template-publish')

    expect(await publish({})).toMatchObject({ ok: true, action: 'publish' })
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
