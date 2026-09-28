import { describe, expect, it } from 'vitest'
import {
  buildCarryListCall,
  isIssuable,
  planStageMoves,
  readCarryItems,
  planStages,
  readDefaultCategoryId,
  readStages,
  stageCodeOf,
  SURVEY_STAGES,
  surveyMoveOf,
  surveyStateFields,
  surveyStateOf,
  TEMPLATE_STAGES,
  templateMoveOf,
  templateStateFields,
  templateStateOf,
  type StagedRef,
} from '../../server/domain/portals/stages'
import type { SmartProcessRef } from '../../server/domain/portals/smart-processes'

/**
 * Штатные стадии вместо своего поля «Состояние» — `server/domain/portals/stages.ts` (issue #84, п. 21).
 *
 * Идентификаторы — с тестового портала 28.09: «Результат опросов» `id` 10 при `entityTypeId` 1040
 * и воронке 16, «Шаблон опроса» `id` 8 при 1038 и воронке 14. Поля называются по `id`, стадии —
 * по `entityTypeId` и воронке, и перепутать их — ровно тот класс ошибки, что уже был с полями.
 */

const SURVEY_OLD: SmartProcessRef = { id: 10, entityTypeId: 1040 }
const SURVEY: StagedRef = { ...SURVEY_OLD, categoryId: 16 }
const TEMPLATE_OLD: SmartProcessRef = { id: 8, entityTypeId: 1038 }
const TEMPLATE: StagedRef = { ...TEMPLATE_OLD, categoryId: 14 }

describe('состояние опроса', () => {
  it('со стадиями читается из стадии, а поле «Состояние» уже ничего не решает', () => {
    const item = { stageId: 'DT1040_16:SUCCESS', UF_CRM_10_STATE: 'sent' }

    expect(surveyStateOf(SURVEY, item)).toBe('completed')
  })

  it('без стадий — по-старому, из поля: портал ещё не мигрирован или тариф не дал', () => {
    // ⚠ Без стадий `stageId` у элемента нет вовсе (замерено 28.09), и чтение из него дало бы
    // пустое состояние всем ссылкам разом.
    expect(surveyStateOf(SURVEY_OLD, { UF_CRM_10_STATE: 'revoked' })).toBe('revoked')
  })

  it('стадия чужой воронки — не наше состояние', () => {
    expect(surveyStateOf(SURVEY, { stageId: 'DT1040_99:SUCCESS' })).toBe('')
    expect(stageCodeOf(SURVEY, 'DT1038_16:SUCCESS')).toBeNull()
  })

  it('опрос пишется стадией, когда стадии есть, и полем — когда нет', () => {
    // ⚠ ГВАРД. Портал без стадий `stageId` молча отбрасывает (замерено 28.09): записав его туда,
    // мы потеряли бы состояние без единой ошибки. Поэтому режим решает `categoryId` в ссылке.
    expect(surveyStateFields(SURVEY, 'completed')).toEqual({ stageId: 'DT1040_16:SUCCESS' })
    expect(surveyStateFields(SURVEY_OLD, 'completed')).toEqual({ UF_CRM_10_STATE: 'completed' })
  })
})

describe('состояние шаблона: публикация решается датой, а не стадией', () => {
  it('ГЛАВНОЕ: черновик, перетащенный в «Опубликован», остаётся черновиком и не выпускается', () => {
    // ⚠ ГВАРД ПОД ОБХОД ПРОВЕРОК. Стадию сотрудник двигает в канбане, а публикация проверяет
    // схему — диапазоны без дыр. Ровно этот обход владелец показал на живой проверке правкой
    // поля «Состояние». Дату публикации пишет только наша публикация, и поле закрыто.
    const dragged = { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_PUBLISHED_AT: '' }

    expect(templateStateOf(TEMPLATE, dragged)).toBe('draft')
    expect(isIssuable(TEMPLATE, dragged)).toBe(false)
  })

  it('ГЛАВНОЕ: опубликованная, перетащенная в «Черновик», остаётся неизменяемой', () => {
    // Иначе конструктор открыл бы для правки версию, по которой уже собирают ответы.
    const dragged = { stageId: 'DT1038_14:NEW', UF_CRM_8_PUBLISHED_AT: '2026-09-28T03:00:00+03:00' }

    expect(templateStateOf(TEMPLATE, dragged)).toBe('published')
    // Выпускать по ней перестаём: в канбане она «Черновик», и администратор вправе ждать именно этого.
    expect(isIssuable(TEMPLATE, dragged)).toBe(false)
  })

  it('«Снят с публикации» — не выпускается и не правится', () => {
    const retired = { stageId: 'DT1038_14:FAIL', UF_CRM_8_PUBLISHED_AT: '2026-09-28T03:00:00+03:00' }

    expect(templateStateOf(TEMPLATE, retired)).toBe('retired')
    expect(isIssuable(TEMPLATE, retired)).toBe(false)
  })

  it('выпускается ровно одна: с датой публикации и в стадии «Опубликован»', () => {
    const published = { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_PUBLISHED_AT: '2026-09-28T03:00:00+03:00' }

    expect(templateStateOf(TEMPLATE, published)).toBe('published')
    expect(isIssuable(TEMPLATE, published)).toBe(true)
  })

  it('без стадий — по-старому: закрытое поле «Состояние» и есть правда', () => {
    expect(templateStateOf(TEMPLATE_OLD, { UF_CRM_8_STATE: 'published' })).toBe('published')
    expect(isIssuable(TEMPLATE_OLD, { UF_CRM_8_STATE: 'published' })).toBe(true)
    expect(templateStateOf(TEMPLATE_OLD, { UF_CRM_8_STATE: 'что-то руками' })).toBe('')
  })

  it('шаблон пишется стадией, когда стадии есть, и полем — когда нет', () => {
    expect(templateStateFields(TEMPLATE, 'published')).toEqual({ stageId: 'DT1038_14:SUCCESS' })
    expect(templateStateFields(TEMPLATE_OLD, 'draft')).toEqual({ UF_CRM_8_STATE: 'draft' })
  })
})

describe('воронка', () => {
  it('воронку по умолчанию находит по признаку, а не по порядку', () => {
    const answer = { result: { categories: [{ id: 3, isDefault: 'N' }, { id: 16, isDefault: 'Y' }] } }

    expect(readDefaultCategoryId(answer)).toBe(16)
    expect(readDefaultCategoryId({ result: { categories: [] } })).toBeNull()
    // Флаг портал отдаёт и `'Y'`, и `true`: сравнив с одной формой, однажды не нашли бы воронку.
    expect(readDefaultCategoryId({ result: { categories: [{ id: 3, isDefault: false }, { id: 16, isDefault: true }] } })).toBe(16)
  })

  it('стадии разбирает с кодом без префикса и чужие отбрасывает', () => {
    const answer = { result: [
      { ID: '300', STATUS_ID: 'DT1040_16:NEW', NAME: 'Начало' },
      { ID: '301', STATUS_ID: 'DT1040_99:NEW', NAME: 'Чужая' },
    ] }

    expect(readStages(answer, SURVEY)).toEqual([{ id: 300, code: 'NEW', name: 'Начало' }])
  })

  it('переименовывает системные и удаляет лишние — только пока у них имя портала', () => {
    const fresh = [
      { id: 300, code: 'NEW', name: 'Начало' },
      { id: 302, code: 'PREPARATION', name: 'Подготовка' },
      { id: 304, code: 'CLIENT', name: 'Согласование' },
      { id: 306, code: 'SUCCESS', name: 'Успех' },
      { id: 308, code: 'FAIL', name: 'Провал' },
    ]

    const calls = planStages(Object.values(SURVEY_STAGES), fresh)

    expect(calls).toEqual([
      { method: 'crm.status.update', params: { id: 300, fields: { NAME: 'Отправлена', COLOR: '#2FC6F6' } } },
      { method: 'crm.status.update', params: { id: 306, fields: { NAME: 'Пройдена', COLOR: '#9DCF00' } } },
      { method: 'crm.status.update', params: { id: 308, fields: { NAME: 'Отозвана', COLOR: '#A8ADB4' } } },
      { method: 'crm.status.delete', params: { id: 302 } },
      { method: 'crm.status.delete', params: { id: 304 } },
    ])
  })

  it('название администратора не трогает, настроенную воронку — не трогает вовсе', () => {
    // Иначе повтор незавершённой миграции спорил бы с администратором каждый час.
    const renamed = [
      { id: 300, code: 'NEW', name: 'Ждём клиента' },
      { id: 302, code: 'PREPARATION', name: 'Наш этап' },
      { id: 306, code: 'SUCCESS', name: 'Пройдена' },
    ]

    expect(planStages(Object.values(SURVEY_STAGES), renamed)).toEqual([])
  })
})

describe('перенос старого поля «Состояние» в стадии', () => {
  it('ГЛАВНОЕ: переводит только из первой стадии — уже переведённое новым кодом назад не тянет', () => {
    // ⚠ Миграция листает живой портал. Опрос, пройденный, пока она шла, уже стоит в «Пройдена»,
    // а старое поле у него — «sent»: без этого условия его вернуло бы назад.
    const items = [
      { id: 1, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' },
      { id: 2, stageId: 'DT1040_16:SUCCESS', UF_CRM_10_STATE: 'revoked' },
      { id: 3, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'revoked' },
      { id: 4, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'sent' },
    ]

    const calls = planStageMoves(SURVEY, items, surveyMoveOf(SURVEY))

    expect(calls.map(call => [call.params.id, (call.params.fields as { stageId: string }).stageId])).toEqual([
      [1, 'DT1040_16:SUCCESS'],
      [3, 'DT1040_16:FAIL'],
    ])
  })

  it('опубликованную анкету без даты публикации переносит с датой — днём последней правки', () => {
    // ⚠ Замерено 28.09: у всех двенадцати опубликованных анкет тестового портала дата пуста.
    // Без неё они стали бы черновиками, и выпускать ссылки стало бы не по чему.
    const items = [
      { id: 4, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: null, updatedTime: '2026-09-21T14:05:00+03:00' },
      { id: 6, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '2026-09-20T03:00:00+03:00', updatedTime: '2026-09-25T10:00:00+03:00' },
      { id: 20, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'draft', UF_CRM_8_PUBLISHED_AT: null, updatedTime: '2026-09-25T10:00:00+03:00' },
    ]

    const calls = planStageMoves(TEMPLATE, items, templateMoveOf(TEMPLATE, '2026-09-28'))

    expect(calls.map(call => [call.params.id, call.params.fields])).toEqual([
      [4, { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_PUBLISHED_AT: '2026-09-21', UF_CRM_8_STATE: '' }],
      [6, { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_STATE: '' }],
    ])
    // Записанное читается как опубликованное — иначе перенос вышел бы снятием с публикации.
    const moved = { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_PUBLISHED_AT: '2026-09-21' }
    expect(isIssuable(TEMPLATE, moved)).toBe(true)
    expect(TEMPLATE_STAGES.published.code).toBe('SUCCESS')
  })

  it('шаблон не в первой стадии: дату досылаем, стадию не трогаем; правка не прочиталась — день сегодняшний', () => {
    const items = [
      { id: 4, stageId: 'DT1038_14:FAIL', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '', updatedTime: '2026-09-21T14:05:00+03:00' },
      { id: 5, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '', updatedTime: 'не дата' },
      { id: 6, stageId: 'DT1038_14:SUCCESS', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '2026-09-20', updatedTime: '2026-09-25T10:00:00+03:00' },
    ]

    expect(planStageMoves(TEMPLATE, items, templateMoveOf(TEMPLATE, '2026-09-28')).map(call => [call.params.id, call.params.fields])).toEqual([
      [4, { UF_CRM_8_PUBLISHED_AT: '2026-09-21', UF_CRM_8_STATE: '' }],
      [5, { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_PUBLISHED_AT: '2026-09-28', UF_CRM_8_STATE: '' }],
      [6, { UF_CRM_8_STATE: '' }],
    ])
  })

  it('ГЛАВНОЕ: перенос снимает старое поле с каждой переведённой анкеты', () => {
    // ⚠ Иначе повтор переноса нашёл бы её снова и вернул в «Опубликован» после того, как администратор
    // увёл её в «Черновик», а чтение считало бы её неперенесённой. Нашёл `/review` в третьем круге.
    const [move] = planStageMoves(TEMPLATE, [
      { id: 4, stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '2026-09-20', updatedTime: '2026-09-21T14:05:00+03:00' },
    ], templateMoveOf(TEMPLATE, '2026-09-28'))

    expect(move!.params.fields).toHaveProperty('UF_CRM_8_STATE', '')
    // Переведённая, а потом уведённая администратором в «Черновик», — уже не выпускается.
    expect(isIssuable(TEMPLATE, { stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: '', UF_CRM_8_PUBLISHED_AT: '2026-09-20' })).toBe(false)
  })
})

describe('отбор переноса', () => {
  it('ГЛАВНОЕ: имена полей в отборе и разборе — буквальные, в camelCase портала', () => {
    // ⚠ Подделка в тестах переноса пересчитывает camelCase своей копией алгоритма, и неверное имя
    // «Даты публикации» прошло бы их все: перенос перезаписал бы настоящую дату днём правки.
    // Имена здесь — буквально, как замерено на портале 28.09. Нашёл `/code-review` во втором круге.
    expect(buildCarryListCall(TEMPLATE, 'template', 0).params.select)
      .toEqual(['id', 'stageId', 'updatedTime', 'ufCrm8State', 'ufCrm8PublishedAt', 'ufCrm8Code', 'ufCrm8Version', 'ufCrm8Schema'])

    const read = readCarryItems({ result: { items: [
      { id: 4, stageId: 'DT1038_14:NEW', updatedTime: '2026-09-25T10:00:00+03:00', ufCrm8State: 'published', ufCrm8PublishedAt: '2026-09-20T03:00:00+03:00' },
    ] } }, TEMPLATE, 'template')

    expect(read).toEqual([expect.objectContaining({ id: 4, UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '2026-09-20T03:00:00+03:00' })])
    // Датированная так и уходит без даты в записи: настоящую дату не трогаем.
    expect(planStageMoves(TEMPLATE, read!, templateMoveOf(TEMPLATE, '2026-09-28'))[0]!.params.fields).toEqual({ stageId: 'DT1038_14:SUCCESS', UF_CRM_8_STATE: '' })
  })

  it('строка, которую не прочитать, делает весь ответ непрочитанным — не пропускается молча', () => {
    // Пропусти мы её, перенос вышел бы «чистым» без её перевода, и поле удалилось бы с её состоянием.
    // Нет номера — и нет самого поля: другое написание его у портала выглядело бы именно так.
    const bad = [null, 'строка', { stageId: 'DT1040_16:NEW', ufCrm10State: 'completed' }, { id: 5, stageId: 'DT1040_16:NEW', UF_CRM_10_STATE: 'completed' }]
    for (const row of bad) {
      expect(readCarryItems({ result: { items: [row] } }, SURVEY, 'survey')).toBeNull()
    }
    expect(readCarryItems({ result: {} }, SURVEY, 'survey')).toBeNull()
    expect(readCarryItems({ result: { items: [] } }, SURVEY, 'survey')).toEqual([])
  })

  it('значение поля не наше — строка читается, но не переводится и перенос не держит', () => {
    // «Published», правленное руками до ревизии 4: прежний код его опубликованным не считал, а отбор
    // портала, похоже, находит его без учёта регистра. Застрять на нём навсегда перенос не должен.
    // Нашёл `/review` в третьем круге панели PR #93.
    const read = readCarryItems({ result: { items: [{ id: 5, stageId: 'DT1038_14:NEW', ufCrm8State: 'Published' }] } }, TEMPLATE, 'template')

    expect(read).toHaveLength(1)
    expect(planStageMoves(TEMPLATE, read!, templateMoveOf(TEMPLATE, '2026-09-28'))).toEqual([])
  })
})

describe('неперенесённая анкета — пока перенос не снял старое поле', () => {
  it('ГЛАВНОЕ: опубликованная полем читается опубликованной и выпускается — не правимым черновиком', () => {
    // ⚠ Смарт-процесс переключается на стадии сразу, а даты у опубликованных полем анкет нет (у всех
    // двенадцати на тестовом портале). Без этого правила от переключения до переноса они читались бы
    // правимыми черновиками. Замена окна «шаблоны на старом поле», в котором каждый круг ревью
    // находил новый край. Третий круг панели PR #93.
    const legacy = { stageId: 'DT1038_14:NEW', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '' }

    expect(templateStateOf(TEMPLATE, legacy)).toBe('published')
    expect(isIssuable(TEMPLATE, legacy)).toBe(true)
  })

  it('снятая администратором до переноса — снятая, а не опубликованная', () => {
    const retired = { stageId: 'DT1038_14:FAIL', UF_CRM_8_STATE: 'published', UF_CRM_8_PUBLISHED_AT: '' }

    expect(templateStateOf(TEMPLATE, retired)).toBe('retired')
    expect(isIssuable(TEMPLATE, retired)).toBe(false)
  })

  it('старое поле с другим значением публикации не даёт', () => {
    expect(templateStateOf(TEMPLATE, { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_STATE: 'draft', UF_CRM_8_PUBLISHED_AT: '' })).toBe('draft')
    expect(templateStateOf(TEMPLATE, { stageId: 'DT1038_14:SUCCESS', UF_CRM_8_STATE: 'Published', UF_CRM_8_PUBLISHED_AT: '' })).toBe('draft')
  })
})

describe('выпуск без стадий у элемента', () => {
  it('администратор выключил стадии — сужать нечем, выпуск решает дата', () => {
    // ⚠ Портал тогда прячет `stageId` (замерено 28.09), и без этой ветки выпуск молча встал бы
    // целиком. Нашёл `/code-review` во втором круге панели PR #93.
    expect(isIssuable(TEMPLATE, { UF_CRM_8_PUBLISHED_AT: '2026-09-20' })).toBe(true)
    expect(isIssuable(TEMPLATE, { UF_CRM_8_PUBLISHED_AT: '' })).toBe(false)
  })
})
