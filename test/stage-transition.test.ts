import { describe, expect, it } from 'vitest'
import {
  isFreshStageEntry,
  inspectStageEntry,
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

  it('ПУСТАЯ переменная окружения → дефолт, а не минимум', () => {
    // `STAGE_ENTRY_WINDOW_SECONDS=` — штатный случай; Number('') даёт 0 и окно молча схлопнулось бы
    // до 5 с (в 12 раз уже документированного), то есть переходы начали бы теряться
    expect(resolveStageEntryWindowSec('')).toBe(STAGE_ENTRY_WINDOW_DEFAULT_SEC)
    expect(resolveStageEntryWindowSec('   ')).toBe(STAGE_ENTRY_WINDOW_DEFAULT_SEC)
    expect(resolveStageEntryWindowSec(null)).toBe(STAGE_ENTRY_WINDOW_DEFAULT_SEC)
  })
  it('вне диапазона — кламп к границам (защита от бессмысленных настроек)', () => {
    expect(resolveStageEntryWindowSec(0)).toBe(STAGE_ENTRY_WINDOW_MIN_SEC)
    expect(resolveStageEntryWindowSec(-100)).toBe(STAGE_ENTRY_WINDOW_MIN_SEC)
    expect(resolveStageEntryWindowSec(999_999)).toBe(STAGE_ENTRY_WINDOW_MAX_SEC)
    expect(resolveStageEntryWindowSec(60.9)).toBe(60) // дробь усекается
  })

  it('не-строка и не-число (объект/массив/булево/Infinity) → дефолт', () => {
    // Значение приходит из окружения/настроек, то есть по типу недоверенное — фиксируем, что любая
    // непригодная форма даёт дефолт, а не 0 (окно в минимум) и не Infinity (окно в бесконечность).
    for (const v of [true, {}, [300], Infinity, -Infinity, () => 300]) {
      expect(resolveStageEntryWindowSec(v)).toBe(STAGE_ENTRY_WINDOW_DEFAULT_SEC)
    }
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

  it('битая дата у САМОЙ СВЕЖЕЙ записи → нет (а не «победила» бы предыдущая — это был бы fail-OPEN)', () => {
    // сделка уже ушла в LOSE, но дата этой записи нечитаема; раньше выигрывала более старая WON
    // и приглашение уходило по покинутой стадии
    const records = [
      { ID: 102, STAGE_ID: 'C1:LOSE', CREATED_TIME: '' },
      rec({ ID: 101, STAGE_ID: 'C1:WON', agoSec: 30 })
    ]
    expect(isFreshStageEntry(records, check('C1:WON'))).toBe(false)
  })

  it('боевой формат портала — ISO со смещением таймзоны — разбирается верно', () => {
    // портал отдаёт CREATED_TIME со смещением (+03:00), а не в UTC-нотации; ошибка разбора
    // молча сдвинула бы окно на часы
    const r = { ID: 1, STAGE_ID: 'C1:WON', CREATED_TIME: '2026-07-31T15:00:30+03:00' } // = 12:00:30Z
    expect(isFreshStageEntry([r], check('C1:WON'))).toBe(true)
    const old = { ID: 1, STAGE_ID: 'C1:WON', CREATED_TIME: '2026-07-31T15:00:30+01:00' } // = 14:00:30Z
    expect(isFreshStageEntry([old], check('C1:WON'))).toBe(false)
  })

  it('строковые ID сравниваются численно, а не лексикографически ("9" против "10")', () => {
    const records = [
      { ID: '9', STAGE_ID: 'C1:WON', CREATED_TIME: new Date(NOW.getTime() - 5000).toISOString() },
      { ID: '10', STAGE_ID: 'C1:LOSE', CREATED_TIME: new Date(NOW.getTime() - 2000).toISOString() }
    ]
    expect(isFreshStageEntry(records, check('C1:LOSE'))).toBe(true) // 10 новее 9
    expect(isFreshStageEntry(records, check('C1:WON'))).toBe(false)
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

describe('latestRecord — упорядочивание записей fail-closed (#17)', () => {
  it('часть записей БЕЗ ID → непригодная побеждает, приглашение не выписывается', () => {
    // Регресс fail-OPEN: раньше запись без ID получала минимальный ранг и НИКОГДА не побеждала запись
    // с ID. Здесь сделка уже ушла в C1:LOSE (свежая запись, но без ID), а старая запись говорит C1:WON —
    // при старом порядке приглашение ушло бы по стадии, которую сделка покинула.
    const records: StageHistoryRecord[] = [
      rec({ ID: 101, STAGE_ID: 'C1:WON', agoSec: 30 }),
      { STAGE_ID: 'C1:LOSE', CREATED_TIME: new Date(NOW.getTime() - 2000).toISOString() }
    ]
    const seen = inspectStageEntry(records, check('C1:WON'))
    expect(seen.fresh).toBe(false)
    expect(seen.observedStageId).toBe('C1:LOSE') // победила именно непригодная по ID запись
  })

  it('ID нет НИ У ОДНОЙ записи → запасной путь по времени (побеждает самая поздняя)', () => {
    const records: StageHistoryRecord[] = [
      { STAGE_ID: 'C1:NEW', CREATED_TIME: new Date(NOW.getTime() - 500_000).toISOString() },
      { STAGE_ID: 'C1:WON', CREATED_TIME: new Date(NOW.getTime() - 2000).toISOString() }
    ]
    expect(isFreshStageEntry(records, check('C1:WON'))).toBe(true)
  })
})

describe('inspectStageEntry — диагностический контракт для логов и smoke (#17)', () => {
  // На observedStageId/ageSec завязаны ДВА потребителя с реальными решениями: лог b24_stage_entry_stale
  // и process.exitCode в scripts/b24-smoke.ts. Смена единиц или знака сломала бы обоих молча.
  it('пустая история → только fresh:false, полей наблюдения нет', () => {
    expect(inspectStageEntry([], check('C1:WON'))).toEqual({ fresh: false })
  })

  it('битая дата → стадия видна, возраст неизвестен', () => {
    const seen = inspectStageEntry([{ ID: 5, STAGE_ID: 'C1:WON', CREATED_TIME: 'не-дата' }], check('C1:WON'))
    expect(seen).toEqual({ fresh: false, observedStageId: 'C1:WON' })
  })

  it('возраст — в СЕКУНДАХ и положительный для прошлого', () => {
    expect(inspectStageEntry([rec({ STAGE_ID: 'C1:WON', agoSec: 120 })], check('C1:WON')).ageSec).toBe(120)
  })

  it('запись «из будущего» → возраст отрицательный (расхождение часов видно в логе)', () => {
    expect(inspectStageEntry([rec({ STAGE_ID: 'C1:WON', agoSec: -120 })], check('C1:WON')).ageSec).toBe(-120)
  })
})

describe('STAGE_HISTORY_ENTITY_TYPE_ID — идентификаторы типа для crm.stagehistory.list', () => {
  it('сделка = 2, лид = 1 (по контракту метода)', () => {
    expect(STAGE_HISTORY_ENTITY_TYPE_ID.deal).toBe(2)
    expect(STAGE_HISTORY_ENTITY_TYPE_ID.lead).toBe(1)
  })
})
