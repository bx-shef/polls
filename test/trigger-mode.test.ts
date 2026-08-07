import { describe, expect, it } from 'vitest'
import {
  resolveTriggerMode,
  eventTriggerEnabled,
  robotTriggerEnabled,
  TRIGGER_MODE_DEFAULT,
  TRIGGER_MODES
} from '../src/bitrix24/trigger-mode'

describe('resolveTriggerMode — режим авто-триггера из настроек', () => {
  it('валидные значения проходят как есть', () => {
    for (const m of TRIGGER_MODES) expect(resolveTriggerMode(m)).toBe(m)
  })

  it('регистр и пробелы не важны (оператор вводит руками)', () => {
    expect(resolveTriggerMode('  ROBOT ')).toBe('robot')
    expect(resolveTriggerMode('Both')).toBe('both')
  })

  it('мусор/пусто/не-строка → дефолт event (работает на всех тарифах)', () => {
    expect(TRIGGER_MODE_DEFAULT).toBe('event')
    for (const bad of ['', '   ', 'нет', 'bizproc', undefined, null, 42, {}]) {
      expect(resolveTriggerMode(bad)).toBe('event')
    }
  })
})

describe('какой путь включён при каждом режиме', () => {
  it('event — только событие', () => {
    expect(eventTriggerEnabled('event')).toBe(true)
    expect(robotTriggerEnabled('event')).toBe(false)
  })

  it('robot — только робот', () => {
    expect(eventTriggerEnabled('robot')).toBe(false)
    expect(robotTriggerEnabled('robot')).toBe(true)
  })

  it('both — оба (осознанный выбор оператора)', () => {
    expect(eventTriggerEnabled('both')).toBe(true)
    expect(robotTriggerEnabled('both')).toBe(true)
  })

  it('ключевой инвариант: вне режима both одновременно два пути НЕ включены', () => {
    // именно двойное включение даёт два приглашения на один переход стадии
    for (const mode of ['event', 'robot'] as const) {
      expect(eventTriggerEnabled(mode) && robotTriggerEnabled(mode)).toBe(false)
    }
  })
})
