import { describe, expect, it } from 'vitest'
import { dealIdFrom, fieldContext, parsePlacementOptions } from '../../app/utils/placement'

/**
 * Чтение того, ради какой сделки портал открыл нашу вкладку. Форма этих данных не наша
 * и не зафиксирована — у соседнего проекта каждая из трёх особенностей ниже стоила
 * живого разбора: вкладка показывала «сделка не определена» на настоящей сделке.
 */

describe('разбор параметров фрейма', () => {
  it('читает объект', () => {
    expect(parsePlacementOptions({ ID: '42' })).toEqual({ ID: '42' })
  })

  it('читает JSON-строку', () => {
    // Портал сериализует параметры по дороге, и наивное `options.ID` тут даёт undefined.
    expect(parsePlacementOptions('{"ID":"42"}')).toEqual({ ID: '42' })
  })

  it.each<[unknown, string]>([
    ['не json', 'испорченная строка'],
    ['"строка"', 'json, но не объект'],
    [null, 'ничего'],
    [42, 'число'],
  ])('не падает на негодном (%#: %s)', (raw) => {
    expect(parsePlacementOptions(raw)).toEqual({})
  })
})

describe('идентификатор сделки', () => {
  it('берётся из параметров фрейма', () => {
    expect(dealIdFrom({ ID: '42' })).toBe(42)
    expect(dealIdFrom('{"ID":42}')).toBe(42)
  })

  it('находится независимо от регистра ключа', () => {
    // Портал шлёт остальные поля заглавными, но встречается и строчный ключ.
    expect(dealIdFrom({ id: '42' })).toBe(42)
  })

  it('берётся из адреса, когда параметров нет вовсе', () => {
    // Не «на всякий случай»: у соседа встречался фрейм с ПУСТЫМИ параметрами целиком.
    expect(dealIdFrom({}, { id: '42' })).toBe(42)
    expect(dealIdFrom(null, { id: 42 })).toBe(42)
  })

  it('параметры фрейма важнее адреса', () => {
    expect(dealIdFrom({ ID: 7 }, { id: 42 })).toBe(7)
  })

  it.each<[unknown, string]>([
    [{ ID: '0' }, 'ноль'],
    [{ ID: '-5' }, 'отрицательный'],
    [{ ID: 'сделка' }, 'не число'],
    [{ ID: '4.5' }, 'дробный'],
    [{}, 'пусто'],
  ])('не выдумывает сделку из негодного значения (%#: %s)', (options) => {
    // Выпустить ссылку не для той сделки хуже, чем не выпустить вовсе.
    expect(dealIdFrom(options)).toBeNull()
  })
})

/**
 * Поле своего типа: портал передаёт другой набор ключей, чем вкладкам.
 *
 * ⚠ Источников два, и они расходятся: официальный гайд по виджету в поле обещает `ENTITY_ID`
 * и `ENTITY_VALUE_ID`, а соседнее приложение на живых порталах читает `ENTITY_DATA`. Тесты
 * держат оба — промах любого значил бы поле, которое не показывает ничего.
 */
describe('контекст поля своего типа', () => {
  it('читает ключи из документации', () => {
    expect(fieldContext({ MODE: 'view', ENTITY_ID: 'CRM_8', ENTITY_VALUE_ID: '15', FIELD_NAME: 'UF_CRM_8_RESULT' }))
      .toEqual({ editing: false, entityId: 'CRM_8', entityTypeId: null, itemId: 15 })
  })

  it('различает режим правки', () => {
    expect(fieldContext({ MODE: 'edit', ENTITY_VALUE_ID: 15 }).editing).toBe(true)
  })

  it('берёт `ENTITY_DATA`, когда документированных ключей нет', () => {
    // Так читает соседнее приложение (`nuxt-uf-legat-info`) на живых порталах.
    expect(fieldContext({ MODE: 'view', ENTITY_DATA: { entityTypeId: '1046', entityId: '15' } }))
      .toEqual({ editing: false, entityId: '', entityTypeId: 1046, itemId: 15 })
  })

  it('разбирает параметры строкой — вместе с вложенным `ENTITY_DATA`', () => {
    const raw = JSON.stringify({ MODE: 'view', ENTITY_ID: 'CRM_8', ENTITY_DATA: { entityTypeId: 1046, entityId: 15 } })

    expect(fieldContext(raw)).toEqual({ editing: false, entityId: 'CRM_8', entityTypeId: 1046, itemId: 15 })
  })

  it('новая карточка — это «элемента нет», а не элемент номер ноль', () => {
    // Документация: у ещё не сохранённой карточки `ENTITY_VALUE_ID` может быть `0`.
    expect(fieldContext({ MODE: 'edit', ENTITY_ID: 'CRM_8', ENTITY_VALUE_ID: 0 }).itemId).toBeNull()
  })

  it('не падает на пустом', () => {
    expect(fieldContext(undefined)).toEqual({ editing: false, entityId: '', entityTypeId: null, itemId: null })
  })
})
