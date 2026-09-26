import { describe, expect, it } from 'vitest'
import { FAQ } from '../../shared/faq'
import { HELP_PLACE_PREFIX, helpPlace, helpRouteFor as route } from '../../app/utils/help'

/** Как зовёт `/app`: с разделами настоящей справки. */
const helpRouteFor = (options: unknown) => route(options, FAQ.map(entry => entry.id))

/**
 * Куда вести фрейм, который портал открыл слайдером справки.
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
    // Те же ловушки, что у вкладок (шапка `app/utils/placement.ts`).
    expect(helpRouteFor(JSON.stringify({ place: 'help-scores' }))).toEqual({ path: '/help', hash: '#scores' })
    expect(helpRouteFor({ PLACE: 'help-scores' })).toEqual({ path: '/help', hash: '#scores' })
  })

  it.each<[string, string]>([
    ['help-нет-такого', 'опечатка в якоре'],
    ['help-../s/abc', 'попытка протащить путь'],
    ['help-scores#x', 'лишнее после якоря'],
  ])('неизвестный якорь открывает справку с начала, а не подставляется в адрес (%s — %s)', (place) => {
    expect(helpRouteFor({ place })).toEqual({ path: '/help', hash: '' })
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
