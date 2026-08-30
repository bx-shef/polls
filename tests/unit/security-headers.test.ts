import { describe, expect, it } from 'vitest'
import { BITRIX24_ZONES, portalCsp, publicPageCsp } from '../../server/utils/security-headers'

/**
 * Гвард под переезд заголовков из nginx в приложение.
 *
 * Пока политику ставил свой nginx, её ломала бы правка конфигурации — заметная.
 * Теперь это обычный код: строку легко подправить «чтобы заработало» и не заметить,
 * что снял защиту. Проверяем то, нарушение чего дорого стоит, а не текст целиком.
 */
describe('политика для приложения внутри портала', () => {
  it('разрешает встраивание во все региональные домены Битрикс24', () => {
    for (const zone of BITRIX24_ZONES) {
      expect(portalCsp).toContain(`https://*.bitrix24.${zone}`)
    }
  })

  it('не забывает двухсегментные зоны', () => {
    // Их легко потерять, если строить список наивным перебором стран.
    expect(portalCsp).toContain('https://*.bitrix24.com.br')
    expect(portalCsp).toContain('https://*.bitrix24.com.tr')
  })

  it('запрещает объекты и вложенные фреймы', () => {
    expect(portalCsp).toContain('object-src \'none\'')
    expect(portalCsp).toContain('frame-src \'none\'')
    expect(portalCsp).toContain('base-uri \'none\'')
  })
})

describe('политика для публичной страницы анкеты', () => {
  it('запрещает встраивание куда бы то ни было', () => {
    expect(publicPageCsp).toContain('frame-ancestors \'none\'')
  })

  it('не пускает eval — в отличие от портальной, где его требует сам Битрикс24', () => {
    expect(publicPageCsp).not.toContain('unsafe-eval')
    expect(portalCsp).toContain('unsafe-eval')
  })

  it('не открывает исходящие соединения наружу', () => {
    // Страница ничего не знает о REST и ходить ей некуда, кроме себя.
    expect(publicPageCsp).toContain('connect-src \'self\'')
    expect(publicPageCsp).not.toContain('bitrix24')
  })

  it('ограничивает отправку формы своим происхождением', () => {
    expect(publicPageCsp).toContain('form-action \'self\'')
  })
})
