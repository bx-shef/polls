import { describe, expect, it } from 'vitest'
import {
  isFreshStageEntry,
  resolveStageEntryWindowSec,
  STAGE_ENTRY_WINDOW_DEFAULT_SEC,
  STAGE_ENTRY_WINDOW_MIN_SEC,
  STAGE_ENTRY_WINDOW_MAX_SEC,
  STAGE_HISTORY_ENTITY_TYPE_ID,
  STAGE_HISTORY_TYPE,
  type StageHistoryRecord
} from '../src/bitrix24/stage-transition'

const NOW = new Date('2026-07-31T12:00:00.000Z')
/** Запись истории со сдвигом на N секунд назад от NOW. */
const rec = (over: Partial<StageHistoryRecord> & { STAGE_ID: string; agoSec: number; ID?: number }): StageHistoryRecord => {
  const { agoSec, ...rest } = over
  return {
    ID: 1,
    TYPE_ID: STAGE_HISTORY_TYPE.intermediate,
    OWNER_ID: 759,
    CREATED_TIME: new Date(NOW.getTime() - agoSec * 1000).toISOString(),
    ...rest
  }
}
const check = (stageId: string, windowSec = 60) => ({ stageId, now: NOW, windowSec })

describe('resolveStageEntryWindowSec — окно из настроек', () => {
  it('нормальное значение проходит; строка из настроек парсится', () => {
    expect(resolveStageEntryWindowSec(120)).toBe(120)
    expect(resolveStageEntryWindowSec('120')).toBe(120)
  })
  it('мусор/пусто → дефолт', () => {
    expect(resolveStageEntryWindowSec(undefined)).toBe(STAGE_ENTRY_WINDOW_DEFAULT_SEC)
    expect(resolveStageEntryWindowSec('abc')).toBe(STAGE_ENTRY_WINDOW_DEFAULT_SEC)
    expect(resolveStageEntryWindowSec(NaN)).toBe(STAGE_ENTRY_WINDOW_DEFAULT_SEC)
  })
  it('вне диапазона — кламп к границам (защита от бессмысленных настроек)', () => {
    expect(resolveStageEntryWindowSec(0)).toBe(STAGE_ENTRY_WINDOW_MIN_SEC)
    expect(resolveStageEntryWindowSec(-100)).toBe(STAGE_ENTRY_WINDOW_MIN_SEC)
    expect(resolveStageEntryWindowSec(999_999)).toBe(STAGE_ENTRY_WINDOW_MAX_SEC)
    expect(resolveStageEntryWindowSec(60.9)).toBe(60) // дробь усекается
  })
})

describe('isFreshStageEntry — был ли вход в стадию ТОЛЬКО ЧТО', () => {
  it('переход в триггерную стадию секунду назад → да', () => {
    expect(isFreshStageEntry([rec({ STAGE_ID: 'C1:WON', agoSec: 1 })], check('C1:WON'))).toBe(true)
  })

  it('сделка давно стоит в этой стадии (обычное редактирование) → нет', () => {
    // ровно тот случай, ради которого всё делается: апдейт сделки через час после перехода
    expect(isFreshStageEntry([rec({ STAGE_ID: 'C1:WON', agoSec: 3600 })], check('C1:WON'))).toBe(false)
  })

  it('последний переход — в ДРУГУЮ стадию → нет (даже если триггерная есть в истории)', () => {
    const records = [
      rec({ ID: 1, STAGE_ID: 'C1:WON', agoSec: 300 }),
      rec({ ID: 2, STAGE_ID: 'C1:LOSE', agoSec: 2 }) // ушла дальше
    ]
    expect(isFreshStageEntry(records, check('C1:WON'))).toBe(false)
  })

  it('берётся САМАЯ СВЕЖАЯ запись, порядок в массиве не важен', () => {
    const records = [
      rec({ ID: 5, STAGE_ID: 'C1:WON', agoSec: 2 }),
      rec({ ID: 3, STAGE_ID: 'NEW', agoSec: 900 }),
      rec({ ID: 4, STAGE_ID: 'EXECUTING', agoSec: 400 })
    ]
    expect(isFreshStageEntry(records, check('C1:WON'))).toBe(true)
  })

  it('одинаковое время → выигрывает больший ID (монотонный)', () => {
    const records = [
      rec({ ID: 10, STAGE_ID: 'EXECUTING', agoSec: 5 }),
      rec({ ID: 11, STAGE_ID: 'C1:WON', agoSec: 5 })
    ]
    expect(isFreshStageEntry(records, check('C1:WON'))).toBe(true)
    expect(isFreshStageEntry(records, check('EXECUTING'))).toBe(false)
  })

  it('граница окна: ровно на границе — да, за ней — нет', () => {
    expect(isFreshStageEntry([rec({ STAGE_ID: 'WON', agoSec: 60 })], check('WON', 60))).toBe(true)
    expect(isFreshStageEntry([rec({ STAGE_ID: 'WON', agoSec: 61 })], check('WON', 60))).toBe(false)
  })

  it('часы портала чуть впереди наших → всё равно свежий (симметричное окно)', () => {
    expect(isFreshStageEntry([rec({ STAGE_ID: 'WON', agoSec: -10 })], check('WON', 60))).toBe(true)
    expect(isFreshStageEntry([rec({ STAGE_ID: 'WON', agoSec: -600 })], check('WON', 60))).toBe(false)
  })

  it('пустая история / битая дата → нет (fail-closed: нет доказательства — не приглашаем)', () => {
    expect(isFreshStageEntry([], check('WON'))).toBe(false)
    expect(isFreshStageEntry([{ STAGE_ID: 'WON', CREATED_TIME: 'не-дата' }], check('WON'))).toBe(false)
    expect(isFreshStageEntry([{ STAGE_ID: 'WON' }], check('WON'))).toBe(false)
  })

  it('создание сделки СРАЗУ в триггерной стадии тоже считается входом', () => {
    const created = rec({ STAGE_ID: 'C1:WON', agoSec: 1, TYPE_ID: STAGE_HISTORY_TYPE.created })
    expect(isFreshStageEntry([created], check('C1:WON'))).toBe(true)
  })

  it('смена воронки в триггерную стадию тоже считается входом', () => {
    const moved = rec({ STAGE_ID: 'C2:WON', agoSec: 1, TYPE_ID: STAGE_HISTORY_TYPE.categoryChange })
    expect(isFreshStageEntry([moved], check('C2:WON'))).toBe(true)
  })
})

describe('STAGE_HISTORY_ENTITY_TYPE_ID — идентификаторы типа для crm.stagehistory.list', () => {
  it('сделка = 2, лид = 1 (по контракту метода)', () => {
    expect(STAGE_HISTORY_ENTITY_TYPE_ID.deal).toBe(2)
    expect(STAGE_HISTORY_ENTITY_TYPE_ID.lead).toBe(1)
  })
})
