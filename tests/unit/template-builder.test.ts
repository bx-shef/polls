import { describe, expect, it } from 'vitest'
import { buildTabHandlerUrl, templateTabPlacement } from '../../server/domain/portals/placements'
import { buildGetTemplateItemCall, readTemplateItem } from '../../server/domain/templates/portal-calls'

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

    expect(item).toEqual({ id: 42, code: 'brand', version: 0, state: 'draft', schema: null })
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
