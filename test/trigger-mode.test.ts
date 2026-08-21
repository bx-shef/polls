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
    expect(resolveTriggerMode(' Event')).toBe('event')
  })

  it('снятое значение `both` больше НЕ распознаётся и падает на дефолт', () => {
    // ⚠️ Не косметика. `both` включал оба пути сразу, а ключи перехода у них разные по построению
    // (`ID` записи истории против момента срабатывания, #175) — дедуп их не склеивает, и клиент
    // получал два приглашения и два ответа в аналитике. Полезного состояния у настройки не было ни
    // одного: вне триггер-стадии робот не создаёт ничего вовсе, то есть `both` был тождественен
    // `event`. Портал, где значение осталось в окружении, безопасно уезжает на `event`, а `env:check`
    // называет переменную и перечисляет допустимые.
    expect(TRIGGER_MODES as readonly string[]).not.toContain('both')
    expect(resolveTriggerMode('both')).toBe('event')
    expect(eventTriggerEnabled(resolveTriggerMode('both'))).toBe(true)
    expect(robotTriggerEnabled(resolveTriggerMode('both'))).toBe(false)
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

  it('ключевой инвариант: ни при каком режиме два пути не включены одновременно', () => {
    // Именно двойное включение даёт два приглашения на один переход стадии. Перебор идёт по ВСЕМУ
    // списку режимов, а не по паре литералов: добавленный режим обязан пройти ту же проверку, иначе
    // защита от дубля вернётся к «мы же помним».
    for (const mode of TRIGGER_MODES) {
      expect(eventTriggerEnabled(mode) && robotTriggerEnabled(mode), mode).toBe(false)
      expect(eventTriggerEnabled(mode) || robotTriggerEnabled(mode), mode).toBe(true)
    }
  })
})
