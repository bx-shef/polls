import { describe, expect, it } from 'vitest'
import {
  buildCompleteSurveyCall,
  buildReadSurveyItemCall,
  parentFieldNames,
  readAssignedById,
  readParentDealId,
  readUpdatedItemId,
} from '../../server/domain/answers/portal-calls'
import { buildFieldName } from '../../server/domain/portals/smart-processes'
import type { SurveyScore } from '../../server/domain/surveys/scoring'

/**
 * Вызовы, которыми ответ попадает в портал. Классы отказов здесь те же, что уже ловились
 * при выпуске ссылки: имена полей в чужой форме, связь с сущностью, принятый на веру ответ.
 */

const SURVEY = { entityTypeId: 1048, id: 44 }
const ITEM = 777

const SCORE: SurveyScore = {
  sections: [
    { key: 'product', title: 'Продукт', score: 8.6, answered: 2, scored: 2, band: null },
    { key: 'open', title: 'Открытые', score: null, answered: 0, scored: 0, band: null },
  ],
  overall: 8.6,
}

const AT = new Date('2026-09-16T10:00:00.000Z')

describe('запись ответа в элемент опроса', () => {
  it('просит оригинальные имена полей', () => {
    // Без этого `crm.item.*` адресует поля в camelCase, а создавали мы их как
    // `UF_CRM_44_STATE`. На угадывании преобразования мы уже обжигались.
    const call = buildCompleteSurveyCall(SURVEY, ITEM, { answers: { a: 9 }, score: SCORE, completedAt: AT })

    expect(call.method).toBe('crm.item.update')
    expect(call.params.useOriginalUfNames).toBe('Y')
    expect(call.params.fields).toHaveProperty(buildFieldName(44, 'STATE'), 'completed')
  })

  it('кладёт ответы и баллы по секциям как JSON', () => {
    const call = buildCompleteSurveyCall(SURVEY, ITEM, {
      answers: { a: 9, b: 8, t: 'текст' },
      score: SCORE,
      completedAt: AT,
    })
    const fields = call.params.fields as Record<string, unknown>

    expect(JSON.parse(String(fields[buildFieldName(44, 'ANSWERS')]))).toEqual({ a: 9, b: 8, t: 'текст' })
    expect(JSON.parse(String(fields[buildFieldName(44, 'SCORES')]))[0]).toEqual({
      key: 'product', score: 8.6, answered: 2, scored: 2,
    })
  })

  it('сохраняет пропуск как null, а не как ноль', () => {
    // Инвариант проекта доезжает до портала целиком: если `null` превратится здесь в ноль,
    // отличить пропуск от честной нулевой оценки станет невозможно уже на той стороне.
    const call = buildCompleteSurveyCall(SURVEY, ITEM, { answers: { a: null }, score: SCORE, completedAt: AT })
    const fields = call.params.fields as Record<string, unknown>

    expect(JSON.parse(String(fields[buildFieldName(44, 'ANSWERS')]))).toEqual({ a: null })
  })

  it('не ставит итоговый балл, когда его нет', () => {
    // Анкету открыли и отправили, не тронув ни одного балльного вопроса. Ноль в этом поле
    // был бы худшей возможной оценкой, выставленной приложением за клиента.
    const blank: SurveyScore = { sections: [], overall: null }
    const fields = buildCompleteSurveyCall(SURVEY, ITEM, { answers: {}, score: blank, completedAt: AT })
      .params.fields as Record<string, unknown>

    expect(fields).not.toHaveProperty(buildFieldName(44, 'SCORE'))
  })

  it('ставит итоговый балл, когда он есть, — включая ноль', () => {
    const zero: SurveyScore = { sections: [], overall: 0 }
    const fields = buildCompleteSurveyCall(SURVEY, ITEM, { answers: {}, score: zero, completedAt: AT })
      .params.fields as Record<string, unknown>

    expect(fields[buildFieldName(44, 'SCORE')]).toBe(0)
  })
})

describe('связь со сделкой', () => {
  it('читается из поля parentId<entityTypeId>', () => {
    // Та же форма, что и при создании элемента. Ошибиться в ней значит не найти сделку
    // и молча не написать комментарий.
    expect(readParentDealId({ result: { item: { id: 777, parentId2: 351 } } }, 2)).toBe(351)
    expect(readParentDealId({ result: { item: { id: 777, parentId2: '351' } } }, 2)).toBe(351)
  })

  it('говорит, какие поля связи портал прислал на самом деле', () => {
    // ⚠ Диагностика под конкретную беду: `readParentDealId` отдаёт `null` и когда связи
    // нет, и когда она названа иначе, чем мы ждём. Второе означает, что комментарий
    // не придёт НИКОГДА, причём молча. Повод не умозрительный — `normalizeFieldName`
    // в `smart-processes.ts` существует ровно потому, что тот же портал отдаёт имена полей
    // не в той форме, в какой принимает.
    const original = { result: { item: { id: 777, PARENT_ID_2: 351, title: 'Опрос' } } }

    expect(readParentDealId(original, 2)).toBeNull()
    expect(parentFieldNames(original)).toEqual(['PARENT_ID_2'])
  })

  it('имена полей отдаются без значений', () => {
    // ⚠ Эти имена уезжают в журнал. Имя описывает схему смарт-процесса, значение указывает
    // на клиента портала — и уехать туда не должно ни при каких обстоятельствах.
    const item = { result: { item: { id: 777, parentId2: 351, parentId1046: 12 } } }

    expect(parentFieldNames(item)).toEqual(['parentId1046', 'parentId2'])
    expect(JSON.stringify(parentFieldNames(item))).not.toContain('351')
  })

  it('на пустом ответе имён не выдумывает', () => {
    expect(parentFieldNames(null)).toEqual([])
    expect(parentFieldNames({ result: {} })).toEqual([])
  })

  it('отсутствие связи — не ошибка, а «комментировать нечего»', () => {
    expect(readParentDealId({ result: { item: { id: 777 } } }, 2)).toBeNull()
    expect(readParentDealId({ result: { item: { id: 777, parentId2: 0 } } }, 2)).toBeNull()
    expect(readParentDealId({ result: {} }, 2)).toBeNull()
    expect(readParentDealId(null, 2)).toBeNull()
  })

  it('элемент читается оригинальными именами полей', () => {
    const call = buildReadSurveyItemCall(SURVEY, ITEM)

    expect(call.method).toBe('crm.item.get')
    expect(call.params).toEqual({ entityTypeId: 1048, id: ITEM, useOriginalUfNames: 'Y' })
  })
})

describe('подтверждение портала', () => {
  it('принимает ответ только с годным идентификатором', () => {
    expect(readUpdatedItemId({ result: { item: { id: 777 } } })).toBe(777)
    expect(readUpdatedItemId({ result: { item: { id: '777' } } })).toBe(777)
  })

  it('не считает подтверждением двухсотый ответ без элемента', () => {
    // Портал отвечает двухсотым и на часть ошибок, кладя `error` в тело. Принять такой
    // ответ за успех значит удалить ответ клиента из буфера, не записав его никуда.
    //
    // `id: 0` здесь не для полноты: у соседней `readParentDealId` ровно такой случай
    // проверен, а у этой — решающей, можно ли забыть ответ клиента, — не был. Мутация
    // «убрать проверку id > 0» пережила первую версию тестов. Нашла панель ревью PR #22.
    for (const body of [{ error: 'ACCESS_DENIED' }, { result: {} }, { result: { item: {} } }, null,
      { result: { item: { id: 0 } } }, { result: { item: { id: -1 } } }]) {
      expect(readUpdatedItemId(body)).toBeNull()
    }
  })
})

describe('ответственный за элемент «Опроса»', () => {
  /**
   * ⚠ Границы — по следам панели ревью (issue #42, пункт 4). У близнеца
   * (`readParentDealId`) эти случаи проверены, а здесь был только счастливый путь, где
   * `assignedById` всегда число. Портал же отдаёт числа строками, а отсутствующее поле —
   * как угодно, и цена ошибки видна не сразу: дело с итогом опроса достанется чужому
   * сотруднику или повиснет без ответственного.
   */
  it('читает число и число, присланное строкой', () => {
    expect(readAssignedById({ result: { item: { assignedById: 5 } } })).toBe(5)
    expect(readAssignedById({ result: { item: { assignedById: '5' } } })).toBe(5)
    expect(readAssignedById({ result: { item: { assignedById: ' 5 ' } } })).toBe(5)
  })

  it('на всём, что не похоже на идентификатора, отвечает нулём', () => {
    // Ноль значит «не прочитали»: вызывающий просто не отправит поле, и портал поставит
    // ответственным владельца токена. Это лучше, чем отправить мусор и получить отказ
    // на всей записи итога.
    for (const raw of [0, -1, 1.5, '', '  ', 'пятый', null, undefined, {}, []]) {
      expect(readAssignedById({ result: { item: { assignedById: raw } } }), String(raw)).toBe(0)
    }
  })

  it('на пустом ответе не выдумывает', () => {
    expect(readAssignedById({ result: {} })).toBe(0)
    expect(readAssignedById({ result: { item: {} } })).toBe(0)
    expect(readAssignedById(null)).toBe(0)
  })
})
