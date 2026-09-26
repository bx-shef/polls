import { describe, expect, it } from 'vitest'
import { FAQ } from '../../shared/faq'
import { HELP_PLACE_PREFIX, SLIDER_PENDING, helpPlace, helpRouteFor, isSliderRefusal } from '../../app/utils/help'

/**
 * Куда вести фрейм, который портал открыл слайдером справки, и как понять, что портал отказал.
 *
 * `place` — единственный канал, по которому раздел доезжает до фрейма: строку запроса задаёт портал,
 * хэш не доезжает вовсе (разбор — в `app/utils/help.ts`). Значит, и ошибки здесь тихие: не тот раздел
 * выглядит как «открылось», а пустой якорь — как «справка с начала».
 */

describe('раздел справки из параметров слайдера', () => {
  it('ведёт на раздел, который просила ссылка', () => {
    expect(helpRouteFor({ place: helpPlace('scores') })).toEqual({ path: '/help', hash: '#scores' })
  })

  it('читает параметры и строкой, и с чужим регистром ключа', () => {
    // Те же ловушки, что у вкладок (шапка `app/utils/placement.ts`), и тот же разборщик.
    expect(helpRouteFor(JSON.stringify({ place: 'help-scores' }))).toEqual({ path: '/help', hash: '#scores' })
    expect(helpRouteFor({ PLACE: 'help-scores' })).toEqual({ path: '/help', hash: '#scores' })
  })

  it.each<[string, string]>([
    ['help-../s/abc', 'попытка протащить путь'],
    ['help-scores#x', 'лишнее после якоря'],
    ['help-Scores', 'заглавные'],
    ['help-раздел', 'кириллица'],
    ['help-', 'пустой якорь'],
  ])('чужая форма якоря не попадает в адрес (%s — %s)', (place) => {
    // ⚠ `place` приходит из портала, то есть снаружи. В адрес фрейма из него может попасть только
    // то, что по форме похоже на якорь раздела, — иначе справка открывается с начала.
    expect(helpRouteFor({ place })).toEqual({ path: '/help', hash: '' })
  })

  it('форма якоря допускает каждый настоящий раздел справки', () => {
    // Проверка по форме, а не по списку — значит, форма обязана пропускать все разделы.
    for (const entry of FAQ) expect(helpRouteFor({ place: helpPlace(entry.id) })?.hash).toBe(`#${entry.id}`)
  })

  it.each<[unknown, string]>([
    [{}, 'обычное открытие приложения'],
    [{ place: 'deal-tab' }, 'чужой place'],
    [{ place: 42 }, 'не строка'],
    [null, 'ничего'],
  ])('не справка — никуда не ведёт (%#: %s)', (options) => {
    expect(helpRouteFor(options)).toBeNull()
  })

  it('place собирается из префикса и якоря', () => {
    expect(helpPlace('scores')).toBe(`${HELP_PLACE_PREFIX}scores`)
  })
})

describe('отказ портала открыть слайдер', () => {
  it('тишина — не отказ: слайдер открыт и ждёт, пока его закроют', () => {
    // ⚠ Промис `openSliderAppPage` завершается при ЗАКРЫТИИ слайдера. Прими мы тишину за отказ,
    // поверх открытого слайдера открывалась бы ещё и вкладка браузера.
    expect(isSliderRefusal(SLIDER_PENDING)).toBe(false)
  })

  it('ответ-ошибка портала — отказ', () => {
    // Так портал отвечает там, где слайдер не поддержан; тот же разбор у SDK в `openPath`.
    expect(isSliderRefusal({ result: 'error', errorCode: 'METHOD_NOT_SUPPORTED_ON_DEVICE' })).toBe(true)
  })

  it('исключение — отказ', () => {
    expect(isSliderRefusal(new Error('портал отказал'))).toBe(true)
  })

  it('слайдер закрыли быстро — не отказ', () => {
    expect(isSliderRefusal(undefined)).toBe(false)
    expect(isSliderRefusal({ result: true })).toBe(false)
  })
})
