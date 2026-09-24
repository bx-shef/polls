import { describe, expect, it } from 'vitest'
import {
  buildCreateCrmFieldCall,
  buildWriteScoreCall,
  CONTACT_ENTITY,
  crmFieldName,
  DEAL_ENTITY,
  LAST_SCORE_CODE,
  LAST_SURVEY_AT_CODE,
  planMissingCrmFields,
  readCrmFieldNames,
  SCORE_FIELDS,
  SCORED_ENTITIES,
} from '../../server/domain/portals/crm-fields'
import { COMPANY_ENTITY_TYPE_ID } from '../../server/domain/portals/smart-processes'

/**
 * Поля «оценка» и «дата опроса» на сделке и контакте клиента (issue #23).
 *
 * Балл живёт на элементе смарт-процесса «Опрос», а он дочерняя сущность сделки: до его полей
 * не дотягивается ни фильтр в списке сделок, ни робот на стадии. То есть обещанное клиенту
 * «покажи сделки с оценкой ниже семи» без этих двух полей не работает вовсе.
 *
 * Здесь держатся те детали, ошибка в которых даёт ровно тот исход: поля созданы, а обещание
 * по-прежнему не выполнено — и заметить это можно только глазами в чужой CRM.
 */

describe('создание поля на сущности CRM', () => {
  const score = SCORE_FIELDS.find(field => field.code === LAST_SCORE_CODE)!

  it('просит показывать поле в ФИЛЬТРЕ — в этом вся задача', () => {
    // ⚠ ГЛАВНЫЙ ГВАРД ФАЙЛА. Без `SHOW_FILTER` поле на сделке существует, значение в нём
    // правильное, а в фильтре списка сделок его нет — то есть «покажи сделки с оценкой
    // ниже семи» по-прежнему невозможно. Всё сделано и ничего не получилось.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, score).params.fields as Record<string, unknown>

    expect(fields.SHOW_FILTER).toBe('Y')
  })

  it('у балла стоит PRECISION — иначе портал округлит до целого', () => {
    // ⚠ Подтверждено соседом на живом портале: `double` без `PRECISION` округляется.
    // Балл 7,5 стал бы восьмёркой, и фильтр «ниже семи» врал бы ровно на той границе,
    // ради которой его и настраивают.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, score).params.fields as Record<string, unknown>

    expect(fields.USER_TYPE_ID).toBe('double')
    expect(fields.SETTINGS).toEqual({ PRECISION: 2 })
  })

  it('имя поля идёт БЕЗ префикса — портал добавляет его сам', () => {
    // ⚠ Документация `crm.deal.userfield.add`: «К коду добавляется префикс UF_CRM_».
    // Передав имя уже с префиксом, мы получили бы `UF_CRM_UF_CRM_…` — поле, которое
    // потом не найдём при сверке и создадим второй раз.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, score).params.fields as Record<string, unknown>

    expect(fields.FIELD_NAME).toBe(LAST_SCORE_CODE)
    expect(String(fields.FIELD_NAME)).not.toContain('UF_CRM')
  })

  it('править руками не даёт: оценку ставит приложение', () => {
    // Портал по умолчанию разрешает правку в списке. Отредактированная руками оценка —
    // это оценка клиента, которой клиент не ставил.
    const fields = buildCreateCrmFieldCall(DEAL_ENTITY, score).params.fields as Record<string, unknown>

    expect(fields.EDIT_IN_LIST).toBe('N')
  })

  it('у сделки и контакта разные методы создания', () => {
    expect(buildCreateCrmFieldCall(DEAL_ENTITY, score).method).toBe('crm.deal.userfield.add')
    expect(buildCreateCrmFieldCall(CONTACT_ENTITY, score).method).toBe('crm.contact.userfield.add')
  })
})

describe('какие сущности трогаем', () => {
  it('ровно две: сделка и контакт', () => {
    expect(SCORED_ENTITIES.map(entity => entity.title)).toEqual(['сделка', 'контакт'])
  })

  it('компанию НЕ трогаем', () => {
    // ⚠ Осознанный отказ, а не забывчивость. У компании сделок много, и «последний балл»
    // по компании — это балл случайной из них: число, которое выглядит осмысленным
    // и таковым не является. Плюс каждое поле на чужой сущности остаётся у клиента
    // навсегда — их не удалить вместе с приложением.
    expect(SCORED_ENTITIES.map(entity => entity.entityTypeId)).not.toContain(COMPANY_ENTITY_TYPE_ID)
  })
})

describe('идемпотентность: существующее поле не создаётся второй раз', () => {
  it('узнаёт своё поле в ответе портала', () => {
    const existing = readCrmFieldNames({ result: [{ FIELD_NAME: crmFieldName(LAST_SCORE_CODE) }] })

    expect(planMissingCrmFields(DEAL_ENTITY, SCORE_FIELDS, existing))
      .toHaveLength(SCORE_FIELDS.length - 1)
  })

  it('узнаёт его и в ДРУГОМ написании', () => {
    // ⚠ Тот же приём и та же причина, что у полей смарт-процесса: портал уже показывал,
    // что отдаёт имя не в той форме, в какой принимает. Прямое сравнение однажды сочло бы
    // существующее поле отсутствующим, создание упало бы на дубликате, и идемпотентность
    // установки — главное её свойство — сломалась бы молча.
    const existing = ['ufCrmShefSurveyScore', 'UFCRMSHEFSURVEYAT']

    expect(planMissingCrmFields(DEAL_ENTITY, SCORE_FIELDS, existing)).toEqual([])
  })

  it('на пустом портале планирует оба поля', () => {
    expect(planMissingCrmFields(DEAL_ENTITY, SCORE_FIELDS, [])).toHaveLength(2)
  })

  it('мусор в ответе портала не считает именами полей', () => {
    expect(readCrmFieldNames({ result: [{ FIELD_NAME: '' }, {}, null, 'строка'] })).toEqual([])
    expect(readCrmFieldNames(null)).toEqual([])
  })
})

describe('запись балла в сущность', () => {
  const call = buildWriteScoreCall(DEAL_ENTITY, 351, 7.5, new Date('2026-09-24T14:20:00Z'))
  const fields = call.params.fields as Record<string, unknown>

  it('идёт `crm.item.update` оригинальными именами полей', () => {
    // ⚠ Так во всём проекте. Смешивать `crm.deal.update` и `crm.item.update` на одних
    // и тех же данных — способ однажды не найти поле там, где оно есть.
    expect(call.method).toBe('crm.item.update')
    expect(call.params.useOriginalUfNames).toBe('Y')
  })

  it('кладёт балл как есть, не округляя', () => {
    expect(fields[crmFieldName(LAST_SCORE_CODE)]).toBe(7.5)
  })

  it('дату кладёт днём, без времени', () => {
    // Поле заведено типом `date`, и портал всё равно отрежет время. Отдаём то, что он ждёт.
    expect(fields[crmFieldName(LAST_SURVEY_AT_CODE)]).toBe('2026-09-24')
  })

  it('пишет ровно два поля и ни одного чужого', () => {
    // ⚠ Это ЧУЖАЯ сущность: каждое лишнее поле в `fields` затирает данные клиента.
    expect(Object.keys(fields).sort())
      .toEqual([crmFieldName(LAST_SCORE_CODE), crmFieldName(LAST_SURVEY_AT_CODE)].sort())
  })
})
