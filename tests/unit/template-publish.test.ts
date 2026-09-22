import { describe, expect, it } from 'vitest'
import {
  buildListAllTemplatesCall,
  buildListSurveysCall,
  buildPublishCall,
  planTemplatePublish,
  readTemplateItems,
  readUpdatedItemId,
  tallySurveyUsage,
  usageKey,
  type PortalTemplateItem,
  type VersionUsage,
} from '../../server/domain/import/template-publish'
import type { SmartProcessRef } from '../../server/domain/portals/smart-processes'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Публикация перенесённых черновиков.
 *
 * Цена ошибки здесь выше, чем при переносе: опубликованная версия неизменяема по инварианту
 * проекта. Черновик с неправильным названием чинится правкой, опубликованный — только второй
 * версией поверх первой.
 */

const TEMPLATE: SmartProcessRef = { id: 8, entityTypeId: 1038 }

const SCHEMA: SurveyTemplate = {
  code: 'brand',
  title: 'brand',
  sections: [{ key: 's1', title: 'Секция', scored: true, bands: [], questions: [] }],
}

function item(over: Partial<PortalTemplateItem> = {}): PortalTemplateItem {
  return { id: 4, name: 'Оценка бренд-платформы', code: 'brand', version: 1, state: 'draft', schema: SCHEMA, ...over }
}

describe('что публикуем', () => {
  it('названный черновик публикуется', () => {
    const plan = planTemplatePublish([item()])

    expect(plan.publish).toHaveLength(1)
    expect(plan.publish[0]!.name).toBe('Оценка бренд-платформы')
    expect(plan.skip).toEqual([])
  })

  it('НЕ публикует анкету, которая всё ещё называется своим кодом', () => {
    // ⚠ Главный гвард файла. Перенос называет анкеты кодами за неимением лучшего — названий
    // в источнике нет вовсе. Опубликовав такую, мы заморозили бы «brand» навсегда: версия
    // неизменяема, и единственный выход — вторая версия ради одной строки текста.
    const plan = planTemplatePublish([item({ name: 'brand' })])

    expect(plan.publish).toEqual([])
    expect(plan.skip[0]!.reason).toContain('НЕ НАЗВАНА')
    expect(plan.skip[0]!.reason).toContain('brand')
  })

  it('НЕ публикует анкету с пустым именем', () => {
    // Тот же случай: пустое название хуже кода, а не лучше.
    expect(planTemplatePublish([item({ name: '' })]).publish).toEqual([])
  })

  it('не трогает опубликованную, у которой название уже на месте', () => {
    // ⚠ Отсюда безопасность повторного запуска: она не «аккуратная», а по построению.
    const named = { ...SCHEMA, title: 'Оценка бренд-платформы' }
    const plan = planTemplatePublish([item({ state: 'published', schema: named })])

    expect(plan.publish).toEqual([])
    expect(plan.skip[0]!.reason).toBe('уже опубликована, название на месте')
  })

  it('переименовывает опубликованную, которую ещё никто не прошёл', () => {
    // ⚠ Случай владельца: поле «Состояние» — обычная строка, и `published` вписали руками
    // раньше, чем дошли до названий. Без этой ветки двенадцать анкет навсегда остались бы
    // «brand» и «concept», а чинилось бы это двенадцатью новыми версиями.
    const plan = planTemplatePublish([item({ state: 'published' })])

    expect(plan.publish).toHaveLength(1)
    expect(plan.publish[0]!.action).toBe('rename')
  })

  it('НЕ переименовывает опубликованную, которую уже прошли', () => {
    // ⚠ Здесь инвариант вступает в силу: «правка формулировки задним числом рвёт всю
    // накопленную статистику». Единственный правильный путь — новая версия.
    const used = new Map<string, VersionUsage>([[usageKey('brand', 1), { issued: 3, completed: 2 }]])
    const plan = planTemplatePublish([item({ state: 'published' })], used)

    expect(plan.publish).toEqual([])
    expect(plan.skip[0]!.reason).toContain('нужна новая версия')
  })

  it('выпущенные, но не пройденные ссылки переименованию не мешают — и всё же считаются', () => {
    // Их страницы показывают схему на момент выпуска, то есть прежнее название. Оператор
    // обязан узнать об этом числом, а не догадаться.
    const sent = new Map<string, VersionUsage>([[usageKey('brand', 1), { issued: 3, completed: 0 }]])
    const plan = planTemplatePublish([item({ state: 'published' })], sent)

    expect(plan.publish[0]!.issued).toBe(3)
    expect(plan.publish[0]!.action).toBe('rename')
  })

  it('черновик остаётся публикацией, даже если по нему уже что-то прошли', () => {
    // Статистика по неопубликованной версии нас не останавливает: мы не меняем формулировки,
    // а доводим до состояния, в котором анкета вообще становится видна.
    const used = new Map<string, VersionUsage>([[usageKey('brand', 1), { issued: 1, completed: 1 }]])

    expect(planTemplatePublish([item()], used).publish[0]!.action).toBe('publish')
  })

  it('НЕ публикует анкету с неразобравшейся схемой', () => {
    // Выпустить по ней ссылку значит выдать человеку страницу, которая не откроется.
    const plan = planTemplatePublish([item({ schema: null })])

    expect(plan.publish).toEqual([])
    expect(plan.skip[0]!.reason).toContain('схема не разобралась')
  })

  it('без кода или версии не публикуется, и элемент всё равно назван в отчёте', () => {
    // Иначе оператор увидел бы строку «` v0 — …`» и не понял, о чём она.
    const plan = planTemplatePublish([item({ code: '', version: 0 })])

    expect(plan.publish).toEqual([])
    expect(plan.skip[0]!.code).toBe('элемент 4')
  })

  it('одна неназванная не мешает опубликовать остальные', () => {
    const plan = planTemplatePublish([item(), item({ id: 6, code: 'concept', name: 'concept' })])

    expect(plan.publish.map(p => p.code)).toEqual(['brand'])
    expect(plan.skip.map(s => s.code)).toEqual(['concept'])
  })
})

describe('вызов публикации', () => {
  it('название уезжает И в элемент, И в схему', () => {
    // ⚠ Респондент видит `schema.title`, а не имя элемента: так устроен `readPublishedTemplates`.
    // Записав только состояние, мы опубликовали бы анкету, которая на портале называется
    // по-человечески, а человеку показывается кодом.
    const call = buildPublishCall(TEMPLATE, {
      id: 4, code: 'brand', version: 1, name: 'Оценка бренд-платформы', schema: SCHEMA, action: 'publish', issued: 0,
    }, new Date('2026-09-22T10:00:00Z'))

    const fields = (call.params as { fields: Record<string, unknown> }).fields
    expect(call.method).toBe('crm.item.update')
    expect(fields.title).toBe('Оценка бренд-платформы')
    expect(JSON.parse(fields.UF_CRM_8_SCHEMA as string).title).toBe('Оценка бренд-платформы')
    expect(fields.UF_CRM_8_STATE).toBe('published')
    expect(fields.UF_CRM_8_PUBLISHED_AT).toBe('2026-09-22')
  })

  it('остальная схема не теряется при подмене названия', () => {
    const call = buildPublishCall(TEMPLATE, {
      id: 4, code: 'brand', version: 1, name: 'Новое', schema: SCHEMA, action: 'publish', issued: 0,
    }, new Date('2026-09-22T10:00:00Z'))

    const written = JSON.parse((call.params as { fields: Record<string, string> }).fields.UF_CRM_8_SCHEMA!)
    expect(written.sections).toHaveLength(1)
    expect(written.code).toBe('brand')
  })

  it('адресуется идентификатором элемента', () => {
    const call = buildPublishCall(TEMPLATE, {
      id: 42, code: 'brand', version: 1, name: 'Новое', schema: SCHEMA, action: 'publish', issued: 0,
    }, new Date())

    expect((call.params as { id: number }).id).toBe(42)
  })
})

describe('чтение элементов с портала', () => {
  it('просит `*`, а не перечень полей', () => {
    // ⚠ ГВАРД ПОД НАЙДЕННЫЙ ЖИВЬЁМ ДЕФЕКТ. С `useOriginalUfNames: 'Y'` портал honours
    // в `select` только оригинальные имена пользовательских полей, а системные — `id`,
    // `title` — молча выбрасывает, в любом написании. Перечислив их, мы получили бы список
    // без идентификаторов: публиковать нечем, потому что `crm.item.update` адресуется `id`.
    const call = buildListAllTemplatesCall(TEMPLATE)

    expect((call.params as { select: string[] }).select).toEqual(['*'])
  })

  it('перелистывание уходит параметром `start`, а первая страница без него', () => {
    expect((buildListAllTemplatesCall(TEMPLATE).params as Record<string, unknown>).start).toBeUndefined()
    expect((buildListAllTemplatesCall(TEMPLATE, 50).params as Record<string, unknown>).start).toBe(50)
  })

  it('разбирает элемент целиком', () => {
    const items = readTemplateItems({
      result: {
        items: [{
          id: 4,
          title: '  Оценка бренд-платформы  ',
          UF_CRM_8_CODE: 'brand',
          UF_CRM_8_VERSION: '1',
          UF_CRM_8_STATE: 'draft',
          UF_CRM_8_SCHEMA: JSON.stringify(SCHEMA),
        }],
      },
    }, TEMPLATE)

    // Пробелы по краям имени срезаются: иначе «назвал» и «не назвал» различались бы
    // невидимым символом.
    expect(items[0]).toMatchObject({ id: 4, name: 'Оценка бренд-платформы', code: 'brand', version: 1, state: 'draft' })
    expect(items[0]!.schema?.sections).toHaveLength(1)
  })

  it('нечитаемая схема — это `null`, а не поломка разбора', () => {
    // Элемент обязан доехать до отчёта: оператор должен узнать, что он есть и почему пропущен.
    const items = readTemplateItems({
      result: { items: [{ id: 4, title: 'Имя', UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: 1, UF_CRM_8_SCHEMA: '{сломано' }] },
    }, TEMPLATE)

    expect(items).toHaveLength(1)
    expect(items[0]!.schema).toBeNull()
  })

  it('схема не того вида — тоже `null`', () => {
    // Валидный JSON без секций не является схемой анкеты, и открывать по нему страницу нечем.
    const items = readTemplateItems({
      result: { items: [{ id: 4, title: 'Имя', UF_CRM_8_SCHEMA: '{"title":"Есть"}' }] },
    }, TEMPLATE)

    expect(items[0]!.schema).toBeNull()
  })

  it('элемент без идентификатора пропускается', () => {
    // Публиковать его нечем, а молчаливая попытка ушла бы в портал с `id: NaN`.
    expect(readTemplateItems({ result: { items: [{ title: 'Имя' }] } }, TEMPLATE)).toEqual([])
  })

  it('чужой ответ — пустой список, а не исключение', () => {
    expect(readTemplateItems(null, TEMPLATE)).toEqual([])
    expect(readTemplateItems({ result: {} }, TEMPLATE)).toEqual([])
  })
})

describe('ответ портала на правку', () => {
  it('элемент вернулся — правка дошла', () => {
    expect(readUpdatedItemId({ result: { item: { id: 4 } } })).toBe(4)
  })

  it('успех без элемента — это не успех', () => {
    // ⚠ Двухсотый ответ без элемента означает, что портал принял запрос и ничего не изменил.
    // Посчитав это успехом, мы отчитались бы о публикации, которой не было.
    expect(readUpdatedItemId({ result: {} })).toBeNull()
    expect(readUpdatedItemId({ result: { item: { id: 0 } } })).toBeNull()
    expect(readUpdatedItemId(null)).toBeNull()
  })
})

describe('дата публикации', () => {
  it('ставится при публикации черновика', () => {
    const call = buildPublishCall(TEMPLATE, {
      id: 4, code: 'brand', version: 1, name: 'Новое', schema: SCHEMA, action: 'publish', issued: 0,
    }, new Date('2026-09-22T10:00:00Z'))

    expect((call.params as { fields: Record<string, unknown> }).fields.UF_CRM_8_PUBLISHED_AT).toBe('2026-09-22')
  })

  it('НЕ переписывается при переименовании', () => {
    // ⚠ Опубликованная версия публиковалась не сегодня. Переписав дату, мы соврали бы
    // в единственном поле, по которому потом восстанавливают, когда анкета вышла.
    const call = buildPublishCall(TEMPLATE, {
      id: 4, code: 'brand', version: 1, name: 'Новое', schema: SCHEMA, action: 'rename', issued: 0,
    }, new Date('2026-09-22T10:00:00Z'))

    expect((call.params as { fields: Record<string, unknown> }).fields).not.toHaveProperty('UF_CRM_8_PUBLISHED_AT')
  })
})

describe('сводка использования версий', () => {
  const SURVEY: SmartProcessRef = { id: 10, entityTypeId: 1040 }

  function survey(code: string, version: number, state: string) {
    return { UF_CRM_10_TEMPLATE_CODE: code, UF_CRM_10_TEMPLATE_VERSION: version, UF_CRM_10_STATE: state }
  }

  it('считает выпущенные и пройденные по паре «код + версия»', () => {
    const usage = tallySurveyUsage({
      result: { items: [survey('brand', 1, 'sent'), survey('brand', 1, 'completed'), survey('brand', 2, 'completed')] },
    }, SURVEY)

    expect(usage.get(usageKey('brand', 1))).toEqual({ issued: 2, completed: 1 })
    expect(usage.get(usageKey('brand', 2))).toEqual({ issued: 1, completed: 1 })
  })

  it('копится по страницам, а не заводится заново на каждой', () => {
    // ⚠ Иначе сводка отражала бы только последнюю страницу, и версия с сотней пройденных
    // опросов на первой странице выглядела бы нетронутой.
    const usage = tallySurveyUsage({ result: { items: [survey('brand', 1, 'completed')] } }, SURVEY)
    tallySurveyUsage({ result: { items: [survey('brand', 1, 'sent')] } }, SURVEY, usage)

    expect(usage.get(usageKey('brand', 1))).toEqual({ issued: 2, completed: 1 })
  })

  it('просит только код, версию и состояние — ответы респондента не нужны', () => {
    // ⚠ `select: ['*']` притащил бы тексты, которые писал респондент, в память скрипта
    // на ноутбуке оператора. Узкий перечень тут не про вес, а про то, чего мы у себя не держим.
    const select = (buildListSurveysCall(SURVEY).params as { select: string[] }).select

    expect(select).toEqual(['UF_CRM_10_TEMPLATE_CODE', 'UF_CRM_10_TEMPLATE_VERSION', 'UF_CRM_10_STATE'])
    expect(select).not.toContain('UF_CRM_10_ANSWERS')
  })

  it('строки без кода или версии не попадают в сводку', () => {
    const usage = tallySurveyUsage({ result: { items: [survey('', 1, 'sent'), { UF_CRM_10_TEMPLATE_CODE: 'x' }] } }, SURVEY)

    expect(usage.size).toBe(0)
  })

  it('чужой ответ не ломает разбор', () => {
    expect(tallySurveyUsage(null, SURVEY).size).toBe(0)
  })
})
