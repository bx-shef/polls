import { describe, expect, it } from 'vitest'
import { buildTabHandlerUrl, templateTabPlacement } from '../../server/domain/portals/placements'
import {
  buildGetTemplateItemCall,
  buildNewVersionCall,
  buildPublishTemplateCall,
  nextVersion,
  readTemplateItem,
  readVersionsOfCode,
} from '../../server/domain/templates/portal-calls'

/**
 * Вкладка конструктора: код точки встраивания и чтение элемента шаблона.
 *
 * ⚠ Два числа у одного смарт-процесса, и они РАЗНЫЕ. На тестовом портале у «Шаблона опроса»
 * `entityTypeId = 1038`, а `id = 8`. Код точки встраивания собирается из первого
 * (документация: «у кода `CRM_DYNAMIC_183_DETAIL_TAB` идентификатор типа равен 183»),
 * а имена пользовательских полей — из второго (`UF_CRM_8_SCHEMA`). Оба механизма стоят
 * в одном файле обустройства и относятся к одному и тому же смарт-процессу.
 *
 * Поэтому образцы ниже намеренно взяты такие, где числа не совпадают: тест, написанный
 * на `{ entityTypeId: 8, id: 8 }`, прошёл бы при любой из двух ошибок.
 */

/** Настоящая пара с тестового портала: числа разные, и в этом весь смысл. */
const TEMPLATE = { entityTypeId: 1038, id: 8 }

describe('код точки встраивания', () => {
  it('ГЛАВНОЕ: собирается из entityTypeId, а не из id смарт-процесса', () => {
    // ⚠ Перепутать эти два числа — вопрос одной буквы, и портал ответит
    // `ERROR_PLACEMENT_NOT_FOUND`: вкладки просто не будет, а установка отчитается успехом,
    // потому что отказ регистрации её не роняет. То есть заметить нечем, кроме этого теста.
    //
    // ⚠ Первая редакция этого гварда проверяла «в коде нет числа `id`» — и краснела на
    // исправном коде: `id` равен 8, а в `1038` восьмёрка есть. Проверять надо, что два
    // числа дают РАЗНЫЕ коды, а вызывающему уходит именно тип. Второе закрыто гвардом
    // в `tests/unit/provision.test.ts`.
    expect(templateTabPlacement(TEMPLATE.entityTypeId)).toBe('CRM_DYNAMIC_1038_DETAIL_TAB')
    expect(templateTabPlacement(TEMPLATE.id)).not.toBe(templateTabPlacement(TEMPLATE.entityTypeId))
  })

  it('адрес обработчика — абсолютный https, иначе его нет вовсе', () => {
    // ⚠ Относительный адрес портал принял бы и открывал бы его от СВОЕГО домена: обработчиком
    // стала бы страница портала. Отказ честнее — вкладка, открывающая чужой сайт, снаружи
    // выглядит работающей.
    expect(buildTabHandlerUrl('https://polls.bx-shef.by', '/portal/template-tab'))
      .toBe('https://polls.bx-shef.by/portal/template-tab')
    expect(buildTabHandlerUrl('http://polls.bx-shef.by', '/portal/template-tab')).toBeNull()
    expect(buildTabHandlerUrl('/portal', '/portal/template-tab')).toBeNull()
  })
})

describe('чтение элемента шаблона', () => {
  it('несёт оригинальные имена полей и звёздочку в select', () => {
    // ⚠ Замерено на живом портале: с `useOriginalUfNames: 'Y'` портал honours в `select`
    // только пользовательские поля, а системные молча выбрасывает. Перечень полей вместо
    // звёздочки давал бы ответ БЕЗ `id`, то есть читатель ниже вернул бы `null` всегда.
    const call = buildGetTemplateItemCall(TEMPLATE, 42)

    expect(call.method).toBe('crm.item.get')
    expect(call.params).toMatchObject({ entityTypeId: 1038, id: 42, useOriginalUfNames: 'Y', select: ['*'] })
  })

  it('ГЛАВНОЕ: открывает ЧЕРНОВИК с пустой схемой', () => {
    // ⚠ Здесь конструктор устроен ПРОТИВОПОЛОЖНО выбору анкеты: тот молча пропускает всё,
    // кроме опубликованного с разобранной схемой, — иначе менеджер выпустил бы ссылку
    // на анкету, которой ещё нет. Конструктору же нужен именно такой элемент: карточку
    // создали на портале руками, схемы в ней нет, и собрать анкету можно только открыв её.
    // Отказавшись, мы оставили бы человека наедине с текстовым полем для JSON.
    const item = readTemplateItem({
      result: { item: { id: '42', UF_CRM_8_CODE: 'brand', UF_CRM_8_STATE: 'draft', UF_CRM_8_SCHEMA: '' } },
    }, TEMPLATE)

    expect(item).toEqual({ id: 42, code: 'brand', version: 0, state: 'draft', updatedAt: '', schema: null })
  })

  it('версии нет — ноль, а не единица', () => {
    // «Версии ещё нет» и «версия первая» — разные вещи. Подставив единицу, мы назвали бы
    // черновик первой версией, которую никто не публиковал.
    const item = readTemplateItem({ result: { item: { id: 7 } } }, TEMPLATE)

    expect(item?.version).toBe(0)
  })

  it('читает поля по именам из id смарт-процесса, а не из entityTypeId', () => {
    // Вторая половина той же ловушки: код точки берёт `entityTypeId`, имена полей — `id`.
    // Образец назван по `id` (8); читатель, собравший имя из 1038, не найдёт ничего.
    const item = readTemplateItem({
      result: {
        item: {
          id: 42,
          UF_CRM_8_CODE: 'brand',
          UF_CRM_8_VERSION: '3',
          UF_CRM_8_STATE: 'published',
          UF_CRM_8_SCHEMA: '{"code":"brand","title":"Бренд","sections":[]}',
        },
      },
    }, TEMPLATE)

    expect(item).toMatchObject({ code: 'brand', version: 3, state: 'published' })
    expect(item?.schema).toMatchObject({ code: 'brand', title: 'Бренд' })
  })

  it('чужой ответ — null, а не полупустой шаблон', () => {
    // Полупустой объект дальше по коду выглядит как настоящая анкета без вопросов.
    expect(readTemplateItem({ result: {} }, TEMPLATE)).toBeNull()
    expect(readTemplateItem({ result: { item: { id: 0 } } }, TEMPLATE)).toBeNull()
    expect(readTemplateItem(null, TEMPLATE)).toBeNull()
  })
})

describe('отметка изменения', () => {
  it('читается с портала — на ней держится защита от одновременной правки', () => {
    // ⚠ Вкладка возвращает это значение при сохранении, и запись отказывает, если оно
    // разошлось. Без него две открытые вкладки молча затирают работу друг друга, и обеим
    // показано «Сохранено». Нашёл `/code-review`.
    const item = readTemplateItem({
      result: { item: { id: 42, updatedTime: '2026-09-26T06:00:00+03:00' } },
    }, TEMPLATE)

    expect(item?.updatedAt).toBe('2026-09-26T06:00:00+03:00')
  })

  it('портал не отдал отметку — пусто, и проверять будет нечем', () => {
    // Пустая отметка проверку ПРОПУСКАЕТ: отказывать из-за отсутствующего поля значило бы
    // сломать сохранение целиком ради защиты от редкой гонки.
    expect(readTemplateItem({ result: { item: { id: 42 } } }, TEMPLATE)?.updatedAt).toBe('')
  })
})

describe('публикация версии', () => {
  it('ГЛАВНОЕ: номер считается по ВСЕМ версиям кода, а не по открытой', () => {
    // ⚠ Версия — внешний ключ: по паре «код + версия» живут кэш схемы, выпущенные ссылки
    // и вся статистика. Выдав занятый номер, мы склеили бы две разные анкеты в одну,
    // и прошлые ответы стали бы неотличимы от новых.
    expect(nextVersion([1, 2, 5])).toBe(6)
    // Порядок не важен: берём наибольший, а не последний.
    expect(nextVersion([5, 1, 2])).toBe(6)
  })

  it('первая версия — единица, а не ноль', () => {
    // ⚠ Ноль означает «версии ещё нет» (черновик). Опубликованная нулевая была бы
    // неотличима от неопубликованной.
    expect(nextVersion([])).toBe(1)
    expect(nextVersion([0, 0])).toBe(1)
  })

  it('мусор в номерах не двигает счётчик', () => {
    expect(nextVersion([Number.NaN, -3, 1.5, 2])).toBe(3)
  })

  it('версии чужого кода не считаются', () => {
    // Коды разных анкет живут в одном смарт-процессе, и номера у них свои.
    const response = {
      result: {
        items: [
          { UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: '2' },
          { UF_CRM_8_CODE: 'game', UF_CRM_8_VERSION: '7' },
          { UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: '0' },
        ],
      },
    }

    expect(readVersionsOfCode(response, TEMPLATE, 'brand')).toEqual([2])
  })

  it('публикация ставит состояние, номер и дату', () => {
    const call = buildPublishTemplateCall(
      TEMPLATE,
      42,
      { code: 'brand', title: 'Бренд', sections: [] },
      3,
      new Date('2026-09-26T10:00:00Z'),
    )

    const fields = (call.params as Record<string, unknown>).fields as Record<string, unknown>
    expect(call.method).toBe('crm.item.update')
    expect(fields.UF_CRM_8_STATE).toBe('published')
    expect(fields.UF_CRM_8_VERSION).toBe(3)
    expect(fields.UF_CRM_8_PUBLISHED_AT).toBe('2026-09-26')
    // Заголовок карточки — тот же, что название в схеме: в списке видят первый,
    // респондент в ссылке — второе, и разойтись им нельзя.
    expect(fields.title).toBe('Бренд')
  })

  it('ГЛАВНОЕ: новая версия несёт ТЕ ЖЕ ключи вопросов', () => {
    // ⚠ В этом весь смысл переноса. Ответ по вопросу `q17` первой версии и ответ на него же
    // во второй — один и тот же вопрос, и сравнивать их можно только пока ключ тот же.
    // Выдав новые, мы получили бы вторую версию, не сравнимую с первой ничем.
    const call = buildNewVersionCall(TEMPLATE, {
      code: 'brand',
      title: 'Бренд',
      sections: [{
        key: 'product',
        title: 'Продукт',
        scored: true,
        questions: [{ key: 'q17', sourceKey: 'q17', title: 'A', type: 'scale', weight: 1, scored: true }],
        bands: [],
      }],
    })

    const fields = (call.params as Record<string, unknown>).fields as Record<string, unknown>
    expect(call.method).toBe('crm.item.add')
    expect(fields.UF_CRM_8_STATE).toBe('draft')
    // Номер выдаётся публикацией, а не созданием: брошенный черновик оставил бы дыру.
    expect(fields.UF_CRM_8_VERSION).toBe(0)
    const schema = JSON.parse(fields.UF_CRM_8_SCHEMA as string) as { sections: { questions: { key: string }[] }[] }
    expect(schema.sections[0]!.questions[0]!.key).toBe('q17')
  })
})
