import { describe, expect, it } from 'vitest'
import { portalCsp, publicPageCsp, securityHeadersFor } from '../../server/utils/security-headers'

/**
 * Гвард под переезд заголовков из nginx в приложение.
 *
 * Пока политику ставил свой nginx, её ломала бы правка конфигурации — заметная.
 * Теперь это обычный код: строку легко подправить «чтобы заработало» и не заметить,
 * что снял защиту. Проверяем то, нарушение чего дорого стоит, а не текст целиком.
 */

/**
 * Список зон записан здесь **отдельно и вручную**, а не взят из `BITRIX24_ZONES`.
 * Иначе тест проверял бы самосогласованность: удали зону из массива — строка
 * перестроится, и цикл по тому же массиву останется зелёным.
 */
const EXPECTED_ZONES = [
  'ru', 'by', 'kz', 'ua', 'com', 'eu', 'de', 'fr', 'it', 'es',
  'pl', 'in', 'jp', 'vn', 'mx', 'id', 'com.br', 'com.tr',
]

/** Вырезает одну директиву целиком — иначе проверка на зону проходит на `connect-src`. */
function directive(csp: string, name: string): string {
  return csp.split('; ').find(part => part.startsWith(`${name} `)) ?? ''
}

describe('политика для приложения внутри портала', () => {
  it('разрешает встраивание во все региональные домены Битрикс24', () => {
    const frameAncestors = directive(portalCsp, 'frame-ancestors')

    // Проверяем именно frame-ancestors: раньше утверждения проходили на одном
    // connect-src, и удаление всей директивы оставляло тест зелёным.
    expect(frameAncestors).not.toBe('')
    for (const zone of EXPECTED_ZONES) {
      expect(frameAncestors).toContain(`https://*.bitrix24.${zone}`)
    }
  })

  it('не забывает двухсегментные зоны', () => {
    // Их легко потерять, если строить список наивным перебором стран.
    expect(directive(portalCsp, 'frame-ancestors')).toContain('https://*.bitrix24.com.br')
    expect(directive(portalCsp, 'frame-ancestors')).toContain('https://*.bitrix24.com.tr')
  })

  it('запрещает объекты, вложенные фреймы и отправку формы на сторону', () => {
    expect(portalCsp).toContain(`object-src 'none'`)
    expect(portalCsp).toContain(`frame-src 'none'`)
    expect(portalCsp).toContain(`base-uri 'none'`)
    // form-action не наследуется от default-src — её отсутствие не видно «на глаз».
    expect(portalCsp).toContain(`form-action 'self'`)
  })
})

describe('политика для публичной страницы анкеты', () => {
  it('запрещает встраивание куда бы то ни было', () => {
    expect(directive(publicPageCsp, 'frame-ancestors')).toBe(`frame-ancestors 'none'`)
  })

  it('не пускает eval — в отличие от портальной, где его требует сам Битрикс24', () => {
    expect(publicPageCsp).not.toContain('unsafe-eval')
    expect(portalCsp).toContain('unsafe-eval')
  })

  it('не открывает исходящие соединения наружу', () => {
    // Страница ничего не знает о REST и ходить ей некуда, кроме себя.
    expect(directive(publicPageCsp, 'connect-src')).toBe(`connect-src 'self'`)
    expect(publicPageCsp).not.toContain('bitrix24')
  })
})

describe('выбор заголовков по адресу', () => {
  it('публичной странице даёт свою политику и запрет индексации', () => {
    const headers = securityHeadersFor('/s/abc123')

    expect(headers['Content-Security-Policy']).toBe(publicPageCsp)
    expect(headers['X-Robots-Tag']).toBe('noindex, nofollow')
  })

  it('JSON-ответам не выдаёт портальную политику с eval и доменами портала', () => {
    const csp = securityHeadersFor('/api/health')['Content-Security-Policy'] ?? ''

    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('bitrix24')
    expect(csp).toContain(`default-src 'none'`)
  })

  it('всему остальному — портальную', () => {
    expect(securityHeadersFor('/')['Content-Security-Policy']).toBe(portalCsp)
    expect(securityHeadersFor('/settings')['Content-Security-Policy']).toBe(portalCsp)
  })

  it('общие заголовки ставит везде', () => {
    // Referrer-Policy на /api/** пропал при переезде и вернулся только после ревью.
    for (const path of ['/', '/s/abc', '/api/health']) {
      const headers = securityHeadersFor(path)
      expect(headers['X-Content-Type-Options'], path).toBe('nosniff')
      expect(headers['Referrer-Policy'], path).toBe('no-referrer')
      expect(headers['Strict-Transport-Security'], path).toContain('includeSubDomains')
    }
  })
})
