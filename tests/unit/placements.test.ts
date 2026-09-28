import { describe, expect, it } from 'vitest'
import {
  buildBindTabCall,
  buildDealTabHandlerUrl,
  buildUnbindTabCall,
  DEAL_TAB_PLACEMENT,
  isPlacementAlreadyBound,
  PLACEMENT_ALREADY_BOUND,
} from '../../server/domain/portals/placements'

/**
 * Регистрация вкладки в карточке сделки. Ошибка здесь не падает: она регистрирует вкладку,
 * которая открывает не наш адрес, либо красит исправную переустановку в жёлтое.
 */

describe('регистрация вкладки', () => {
  // ⚠ Названия вкладок здесь — просто строки. Что в бою уходят именно наши, с меткой, держит
  // гвард на вызывающем (`provision-outcome.test.ts`, «английские названия вкладок»): прежний
  // тест стоял на построителе, которого бой не вызывал, и был зелёным, пока портал получал
  // непомеченное «Surveys». Нашли тестировщик, техдиректор и `/code-review` в панели PR #87.
  it('собирает вызов с кодом точки и названиями на обоих языках', () => {
    const call = buildBindTabCall(DEAL_TAB_PLACEMENT, 'https://polls.bx-shef.by/portal/deal-tab', 'Вкладка', 'Tab')

    expect(call).toEqual({
      method: 'placement.bind',
      params: {
        PLACEMENT: DEAL_TAB_PLACEMENT,
        HANDLER: 'https://polls.bx-shef.by/portal/deal-tab',
        TITLE: 'Вкладка',
        LANG_ALL: { ru: { TITLE: 'Вкладка' }, en: { TITLE: 'Tab' } },
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
    expect(buildBindTabCall(DEAL_TAB_PLACEMENT, url, 'Вкладка', 'Tab')).toBeNull()
  })

  it('снимает регистрацию БЕЗ адреса обработчика', () => {
    // Гвард под собственный дефект: с `HANDLER` метод снимает регистрацию только на этот
    // адрес, а снять надо ту, адреса которой мы не знаем, — старую. Первая версия передавала
    // сюда НОВЫЙ адрес: снятие вхолостую, `bind` следом падает с `ERROR_PLACEMENT_MAX_COUNT`,
    // портал остаётся на старом обработчике, а установка отчитывается успехом.
    expect(buildUnbindTabCall(DEAL_TAB_PLACEMENT).params).toEqual({ PLACEMENT: DEAL_TAB_PLACEMENT })
    expect(buildUnbindTabCall(DEAL_TAB_PLACEMENT).params).not.toHaveProperty('HANDLER')
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
