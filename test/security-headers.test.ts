import { describe, expect, it } from 'vitest'
import {
  B24_FRAME_ZONES,
  contentSecurityPolicy,
  frameAncestors,
  parseExtraFrameAncestors,
  securityHeaders
} from '../src/api/security-headers'

describe('frameAncestors — кто может встроить нас в iframe', () => {
  it('свой домен + облачные зоны Bitrix24', () => {
    const v = frameAncestors()
    expect(v.startsWith("'self' ")).toBe(true)
    for (const zone of B24_FRAME_ZONES) expect(v).toContain(`https://*.${zone}`)
  })

  it('чужой домен в список не попадает', () => {
    expect(frameAncestors()).not.toContain('evil')
  })

  it('self-hosted портал добавляется настройкой', () => {
    expect(frameAncestors(['https://crm.acme.local'])).toContain('https://crm.acme.local')
  })
})

describe('parseExtraFrameAncestors — источники из настроек', () => {
  it('разбирает список через запятую и через пробел', () => {
    expect(parseExtraFrameAncestors('https://a.local, https://b.local')).toEqual(['https://a.local', 'https://b.local'])
    expect(parseExtraFrameAncestors('https://a.local https://b.local')).toEqual(['https://a.local', 'https://b.local'])
  })

  it('пусто/не строка → пустой список', () => {
    for (const v of ['', '   ', undefined, null, 42, {}]) expect(parseExtraFrameAncestors(v)).toEqual([])
  })

  it('отбрасывает непригодное, а не роняет всю политику', () => {
    // Мусор внутри CSP ломает директиву ЦЕЛИКОМ — поэтому элемент проще выкинуть.
    expect(parseExtraFrameAncestors("https://ok.local, 'unsafe-inline'; script-src *")).toEqual(['https://ok.local'])
    expect(parseExtraFrameAncestors('http://insecure.local')).toEqual([]) // только https
    expect(parseExtraFrameAncestors('javascript:alert(1)')).toEqual([])
  })
})

describe('contentSecurityPolicy — политика содержимого', () => {
  const csp = contentSecurityPolicy()

  it('по умолчанию разрешено только своё', () => {
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
  })

  it('инлайн-скрипты разрешены — без них Nuxt не отдаст состояние гидратации', () => {
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    // но внешние источники скриптов не открыты
    expect(csp).not.toMatch(/script-src[^;]*https:\/\/(?!\*\.bitrix24)/)
  })

  it('встраивание в iframe ограничено собой и порталами Bitrix24 (защита от кликджекинга)', () => {
    expect(csp).toContain("frame-ancestors 'self' https://*.bitrix24.ru")
  })

  it('директивы разделены точкой с запятой и не содержат переводов строк', () => {
    expect(csp).not.toMatch(/[\r\n]/)
    expect(csp.split('; ').length).toBeGreaterThan(6)
  })
})

describe('securityHeaders — итоговый набор', () => {
  it('всегда: CSP, nosniff, Referrer-Policy, Permissions-Policy', () => {
    const h = securityHeaders()
    expect(h['Content-Security-Policy']).toBeTruthy()
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['Permissions-Policy']).toContain('camera=()')
  })

  it('Referrer-Policy не пускает полный адрес на чужой домен (в нём бывает токен приглашения)', () => {
    expect(securityHeaders()['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
  })

  it('HSTS — только по HTTPS (на http бессмыслен и мешает локальной разработке)', () => {
    expect(securityHeaders({ https: true })['Strict-Transport-Security']).toContain('max-age=')
    expect(securityHeaders({ https: false })['Strict-Transport-Security']).toBeUndefined()
    expect(securityHeaders()['Strict-Transport-Security']).toBeUndefined()
  })

  it('дополнительные источники доезжают до CSP', () => {
    const h = securityHeaders({ extraFrameAncestors: ['https://crm.acme.local'] })
    expect(h['Content-Security-Policy']).toContain('https://crm.acme.local')
  })

  it('в значениях заголовков нет символов, ломающих HTTP-ответ', () => {
    for (const v of Object.values(securityHeaders({ https: true, extraFrameAncestors: ['https://a.local'] }))) {
      expect(v).not.toMatch(/[\r\n]/)
    }
  })
})
