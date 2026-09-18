import { describe, expect, it } from 'vitest'
import { isPreview, portalGate } from '../../app/utils/in-portal'

/**
 * Гейт страниц приложения. Ошибиться здесь легко В ПОЛЬЗУ «показать» — и это худший исход:
 * снаружи портала интерфейс выглядит рабочим, но не работает, и человек читает пустую
 * панель как поломку приложения.
 */

describe('что показывать странице приложения', () => {
  it('пока проверка идёт — ждём, а не решаем', () => {
    // Без этого состояния интерфейс мелькнул бы и схлопнулся в заглушку. Мелькание
    // читается как поломка вернее, чем честное ожидание.
    expect(portalGate({ resolved: false, inPortal: false, preview: false })).toBe('checking')
    expect(portalGate({ resolved: false, inPortal: true, preview: false })).toBe('checking')
  })

  it('внутри портала показываем, снаружи объясняем', () => {
    expect(portalGate({ resolved: true, inPortal: true, preview: false })).toBe('ok')
    expect(portalGate({ resolved: true, inPortal: false, preview: false })).toBe('outside')
  })

  it('обход перекрывает всё, включая незавершённую проверку', () => {
    // На нём держатся тесты, монтирующие страницы вне фрейма.
    expect(portalGate({ resolved: false, inPortal: false, preview: true })).toBe('ok')
  })
})

describe('признак обхода', () => {
  it('только явная единица', () => {
    // Голый `?preview` — случайная ссылка, а не намерение разработчика.
    expect(isPreview('1')).toBe(true)
    expect(isPreview(null)).toBe(false)
    expect(isPreview('')).toBe(false)
    expect(isPreview('0')).toBe(false)
    expect(isPreview('true')).toBe(false)
    expect(isPreview(1)).toBe(false)
    expect(isPreview(undefined)).toBe(false)
  })

  it('в списке значений достаточно одной единицы', () => {
    expect(isPreview(['0', '1'])).toBe(true)
    expect(isPreview(['0', 'нет'])).toBe(false)
  })
})
