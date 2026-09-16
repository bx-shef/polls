import { describe, expect, it } from 'vitest'
import {
  buildBindDealTabCall,
  buildDealTabHandlerUrl,
  buildUnbindDealTabCall,
  DEAL_TAB_PLACEMENT,
  isPlacementAlreadyBound,
  PLACEMENT_ALREADY_BOUND,
} from '../../server/domain/portals/placements'

/**
 * Регистрация вкладки в карточке сделки. Ошибка здесь не падает: она регистрирует вкладку,
 * которая открывает не наш адрес, либо красит исправную переустановку в жёлтое.
 */

describe('регистрация вкладки', () => {
  it('собирает вызов с кодом точки и локализованным названием', () => {
    const call = buildBindDealTabCall('https://polls.bx-shef.by/portal/deal-tab')

    expect(call).toEqual({
      method: 'placement.bind',
      params: {
        PLACEMENT: DEAL_TAB_PLACEMENT,
        HANDLER: 'https://polls.bx-shef.by/portal/deal-tab',
        TITLE: 'Опросы',
        LANG_ALL: { ru: { TITLE: 'Опросы' }, en: { TITLE: 'Surveys' } },
      },
    })
  })

  it.each([
    ['/portal/deal-tab', 'относительный адрес'],
    ['http://polls.bx-shef.by/portal/deal-tab', 'не https'],
    ['https://polls.bx-shef.by', 'без пути'],
    ['', 'пусто'],
    ['   ', 'одни пробелы'],
  ])('отказывается регистрировать негодный адрес (%#: %s)', (url) => {
    // Относительный адрес портал принял бы и открывал бы его от СВОЕГО домена: вкладка
    // выглядела бы работающей, но вела на страницу портала, а не на нашу.
    expect(buildBindDealTabCall(url)).toBeNull()
  })

  it('снимает регистрацию с адресом и без него', () => {
    expect(buildUnbindDealTabCall('https://polls.bx-shef.by/portal/deal-tab').params)
      .toEqual({ PLACEMENT: DEAL_TAB_PLACEMENT, HANDLER: 'https://polls.bx-shef.by/portal/deal-tab' })
    expect(buildUnbindDealTabCall().params).toEqual({ PLACEMENT: DEAL_TAB_PLACEMENT })
  })
})

describe('повторная регистрация', () => {
  it.each<[unknown, string]>([
    [PLACEMENT_ALREADY_BOUND, 'строкой'],
    [{ error: PLACEMENT_ALREADY_BOUND }, 'сырым конвертом'],
    [{ code: PLACEMENT_ALREADY_BOUND }, 'полем code'],
    [new Error(`portal said ${PLACEMENT_ALREADY_BOUND}`), 'внутри Error'],
  ])('узнаётся «уже зарегистрировано» (%#: %s)', (error) => {
    // На переустановке это штатный ответ. Считать его ошибкой — значит красить
    // исправную установку в жёлтое.
    expect(isPlacementAlreadyBound(error)).toBe(true)
  })

  it.each<[unknown, string]>([
    [null, 'ничего'],
    [{ error: 'ACCESS_DENIED' }, 'настоящий отказ'],
    [new Error('portal is down'), 'падение портала'],
    ['Обработчик уже зарегистрирован', 'локализованный текст без кода'],
  ])('не принимается за «уже зарегистрировано» (%#: %s)', (error) => {
    // Текст портал отдаёт локализованным, и завтра он придёт на другом языке —
    // поэтому смотрим на код, а не на подстроку человеческого описания.
    expect(isPlacementAlreadyBound(error)).toBe(false)
  })
})

describe('адрес обработчика', () => {
  it('собирается из публичного хоста портала', () => {
    expect(buildDealTabHandlerUrl('https://polls.bx-shef.by')).toBe('https://polls.bx-shef.by/portal/deal-tab')
    expect(buildDealTabHandlerUrl('https://opros.example.com/')).toBe('https://opros.example.com/portal/deal-tab')
  })

  it.each([[''], ['http://polls.bx-shef.by'], ['polls.bx-shef.by'], ['   ']])(
    'не собирается из негодного хоста (%#)',
    (host) => {
      expect(buildDealTabHandlerUrl(host)).toBeNull()
    },
  )
})
