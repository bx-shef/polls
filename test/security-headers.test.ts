import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  B24_FRAME_ZONES,
  B24_SCRIPT_SRC,
  CSP_MODES,
  HSTS_VALUE,
  MAX_EXTRA_FRAME_ANCESTORS,
  contentSecurityPolicy,
  frameAncestors,
  isHttpsRequest,
  isNoFrameRoute,
  parseExtraFrameAncestors,
  resolveCspMode,
  sanitizeFrameAncestors,
  securityHeaders
} from '../src/api/security-headers'
import { isAllowedPortalDomain } from '../src/bitrix24/frame'

/**
 * Зоны перечислены ЛИТЕРАЛЬНО, а не импортом из того же модуля: иначе тест подтверждал бы сам себя —
 * удали зону из константы, и цикл просто отработает короче, оставшись зелёным.
 */
const EXPECTED_ZONES = [
  'bitrix24.ru',
  'bitrix24.com',
  'bitrix24.by',
  'bitrix24.kz',
  'bitrix24.eu',
  'bitrix24.de',
  'bitrix24.ua',
  'bitrix24.pl',
  'bitrix24.fr',
  'bitrix24.it',
  'bitrix24.es',
  'bitrix24.com.br',
  'bitrix24.in'
]

describe('B24_FRAME_ZONES — список зон', () => {
  it('совпадает с ожидаемым (правка списка обязана быть осознанной)', () => {
    expect([...B24_FRAME_ZONES]).toEqual(EXPECTED_ZONES)
  })

  it('КАЖДАЯ зона проходит allowlist установки — иначе в списке зона, из которой не установиться', () => {
    // Так поймали `bitrix24.com.tr`: он был в CSP, но allowlist установки его не пропускает
    // (двухуровневые зоны, кроме com.br, отвергаются) — то есть лежал мёртвым грузом.
    for (const zone of B24_FRAME_ZONES) {
      expect(isAllowedPortalDomain(`demo.${zone}`), `зона ${zone}`).toBe(true)
    }
  })
})

describe('sanitizeFrameAncestors — что попадает в директиву', () => {
  it('ГЛАВНОЕ: `https://*` отбрасывается — иначе фреймить может кто угодно', () => {
    // Это валидный источник CSP со смыслом «любой https-хост»: одна такая настройка снимает
    // защиту от кликджекинга целиком — ровно ту, ради которой всё и делалось.
    expect(sanitizeFrameAncestors(['https://*'])).toEqual([])
    expect(sanitizeFrameAncestors(['https://*.*'])).toEqual([])
    expect(sanitizeFrameAncestors(['https://*.com'])).toEqual([]) // нужна минимум одна точка ПОСЛЕ *.
    expect(frameAncestors(['https://*'])).not.toContain('https://* ')
  })

  it('нормальный хост и подстановочный знак на своём месте — проходят', () => {
    expect(sanitizeFrameAncestors(['https://crm.acme.local'])).toEqual(['https://crm.acme.local'])
    expect(sanitizeFrameAncestors(['https://*.acme.local'])).toEqual(['https://*.acme.local'])
  })

  it('порт разрешён — box-порталы нередко стоят не на 443', () => {
    expect(sanitizeFrameAncestors(['https://box.local:8443'])).toEqual(['https://box.local:8443'])
  })

  it('отбрасывает непригодное, а не роняет всю политику', () => {
    expect(sanitizeFrameAncestors(['http://insecure.local'])).toEqual([]) // только https
    expect(sanitizeFrameAncestors(['https://a.local/path'])).toEqual([]) // путь недопустим
    expect(sanitizeFrameAncestors(['javascript:alert(1)'])).toEqual([])
    expect(sanitizeFrameAncestors(['https://nodot'])).toEqual([]) // нужна хотя бы одна точка
    expect(sanitizeFrameAncestors(['https://a.local', 'мусор'])).toEqual(['https://a.local'])
  })

  it('дубли схлопываются, регистр не создаёт второй записи', () => {
    expect(sanitizeFrameAncestors(['https://A.local', 'https://a.local'])).toEqual(['https://a.local'])
  })

  it('количество ограничено — заголовок уходит на КАЖДЫЙ ответ', () => {
    const many = Array.from({ length: 50 }, (_, i) => `https://p${i}.local`)
    expect(sanitizeFrameAncestors(many)).toHaveLength(MAX_EXTRA_FRAME_ANCESTORS)
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

  it('внедрить лишнюю директиву через настройку нельзя', () => {
    expect(parseExtraFrameAncestors("https://ok.local, 'unsafe-inline'; script-src *")).toEqual(['https://ok.local'])
    // перевод строки в значении = подделка заголовков; должен быть отброшен вместе с хвостом
    expect(parseExtraFrameAncestors('https://a.local\r\nX-Evil: 1')).toEqual(['https://a.local'])
  })
})

describe('contentSecurityPolicy — точная политика', () => {
  it('строка совпадает посимвольно (любая правка директив должна быть видна в диффе теста)', () => {
    const zones = EXPECTED_ZONES.map((z) => `https://*.${z}`).join(' ')
    expect(contentSecurityPolicy()).toBe(
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        `script-src 'self' 'unsafe-inline' ${B24_SCRIPT_SRC}`,
        "font-src 'self' data:",
        "connect-src 'self'",
        `frame-ancestors 'self' ${zones}`,
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'"
      ].join('; ')
    )
  })

  it('РЕГРЕСС: разрешён источник скрипта страницы завершения установки', () => {
    // `server/api/b24/install.post.ts` грузит //api.bitrix24.com/api/v1/ и зовёт BX24.installFinish().
    // Заблокируй его — и установка молча не завершится: скрипт не загрузился, вызов в try/catch,
    // портал не пометил установку, а человек видит «Приложение установлено».
    const html = readFileSync(resolve(process.cwd(), 'server/api/b24/install.post.ts'), 'utf8')
    const externalScripts = [...html.matchAll(/<script\s+src="(\/\/|https?:\/\/)([^"/]+)/gi)].map((m) => m[2])
    expect(externalScripts.length).toBeGreaterThan(0) // сам факт наличия внешнего скрипта
    const csp = contentSecurityPolicy()
    for (const host of externalScripts) {
      expect(csp, `внешний скрипт ${host} обязан быть разрешён в script-src`).toContain(`https://${host}`)
    }
  })

  it('чужой домен не появляется ни в одной директиве', () => {
    expect(contentSecurityPolicy()).not.toMatch(/evil|\*\s|\*$/)
  })

  it('дополнительный источник доезжает до frame-ancestors', () => {
    expect(contentSecurityPolicy(['https://crm.acme.local'])).toContain(
      "frame-ancestors 'self' https://*.bitrix24.ru"
    )
    expect(contentSecurityPolicy(['https://crm.acme.local'])).toContain('https://crm.acme.local')
  })

  it('в политике нет переводов строк (иначе это подделка заголовков)', () => {
    expect(contentSecurityPolicy(['https://a.local'])).not.toMatch(/[\r\n]/)
  })
})

describe('resolveCspMode — аварийный режим', () => {
  it('дефолт — enforce (мусор и пустое тоже)', () => {
    for (const v of [undefined, '', '  ', 'ENFORCE_X', 42, {}]) expect(resolveCspMode(v)).toBe('enforce')
  })
  it('распознаёт все режимы, регистр не важен', () => {
    for (const m of CSP_MODES) expect(resolveCspMode(m.toUpperCase())).toBe(m)
  })
})

describe('isHttpsRequest — как определяется схема', () => {
  it('X-Forwarded-Proto имеет приоритет и берётся ПЕРВЫЙ элемент цепочки', () => {
    expect(isHttpsRequest({ forwardedProto: 'https' })).toBe(true)
    expect(isHttpsRequest({ forwardedProto: 'HTTPS' })).toBe(true)
    expect(isHttpsRequest({ forwardedProto: '  https  ' })).toBe(true)
    expect(isHttpsRequest({ forwardedProto: 'https, http' })).toBe(true)
    expect(isHttpsRequest({ forwardedProto: 'http, https' })).toBe(false)
  })

  it('заголовка нет → смотрим само соединение', () => {
    expect(isHttpsRequest({ encrypted: true })).toBe(true)
    expect(isHttpsRequest({ encrypted: false })).toBe(false)
    expect(isHttpsRequest({})).toBe(false)
    expect(isHttpsRequest({ forwardedProto: '', encrypted: true })).toBe(true)
  })
})

describe('securityHeaders — итоговый набор', () => {
  it('всегда: CSP, nosniff, точный Referrer-Policy и Permissions-Policy', () => {
    const h = securityHeaders()
    expect(h['Content-Security-Policy']).toBe(contentSecurityPolicy())
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=(), payment=()')
  })

  it('X-Frame-Options НЕ ставим — он сломал бы фрейм портала (его роль играет frame-ancestors)', () => {
    expect(securityHeaders({ https: true })['X-Frame-Options']).toBeUndefined()
  })

  it('режим report → только отчётный заголовок, ничего не блокируется', () => {
    const h = securityHeaders({ cspMode: 'report' })
    expect(h['Content-Security-Policy']).toBeUndefined()
    expect(h['Content-Security-Policy-Report-Only']).toBe(contentSecurityPolicy())
  })

  it('режим off снимает CSP, но остальные заголовки остаются', () => {
    const h = securityHeaders({ cspMode: 'off' })
    expect(h['Content-Security-Policy']).toBeUndefined()
    expect(h['Content-Security-Policy-Report-Only']).toBeUndefined()
    expect(h['X-Content-Type-Options']).toBe('nosniff')
  })

  it('HSTS — только по HTTPS и точным значением', () => {
    expect(securityHeaders({ https: true })['Strict-Transport-Security']).toBe(HSTS_VALUE)
    expect(securityHeaders({ https: false })['Strict-Transport-Security']).toBeUndefined()
    expect(securityHeaders()['Strict-Transport-Security']).toBeUndefined()
  })

  it('HSTS пока на сутки, а не на годы: TLS на проде вживую не проверялся, а срок необратим', () => {
    expect(HSTS_VALUE).toBe('max-age=86400; includeSubDomains')
  })

  it('в значениях заголовков нет символов, ломающих HTTP-ответ — даже из настроек', () => {
    const h = securityHeaders({ https: true, extraFrameAncestors: parseExtraFrameAncestors('https://a.local\r\nX: 1') })
    for (const v of Object.values(h)) expect(v).not.toMatch(/[\r\n]/)
  })
})


describe('isNoFrameRoute — публичную страницу опроса фреймить нельзя вообще', () => {
  it('маршруты контура A → запрет фрейма', () => {
    expect(isNoFrameRoute('/s/csat_postdeal')).toBe(true)
    expect(isNoFrameRoute('/s/csat_postdeal?token=abc')).toBe(true)
    expect(isNoFrameRoute('/s')).toBe(true)
  })

  it('лендинг тоже нельзя фреймить', () => {
    // Иначе любой владелец бесплатного портала Bitrix24 показывает нашу витрину под своей вывеской:
    // по умолчанию `frame-ancestors` разрешает все облачные зоны портала.
    expect(isNoFrameRoute('/')).toBe(true)
    expect(isNoFrameRoute('/?utm_source=x')).toBe(true)
  })

  it('маршруты, которые портал открывает во фрейме, — не трогаем', () => {
    // Запрет здесь сломал бы приложение: дашборд и виджеты живут именно во фрейме портала.
    for (const p of ['/d/csat_postdeal', '/b24/dashboard', '/b24/deal-widget', '/admin/surveys', '/api/health']) {
      expect(isNoFrameRoute(p), p).toBe(false)
    }
    expect(isNoFrameRoute('/settings')).toBe(false) // не ловим по префиксу «/s»
    expect(isNoFrameRoute(undefined)).toBe(false)
  })

  it('запрет реально доезжает до политики', () => {
    expect(contentSecurityPolicy([], true)).toContain("frame-ancestors 'none'")
    expect(securityHeaders({ noFrame: true })['Content-Security-Policy']).toContain("frame-ancestors 'none'")
  })
})

describe('плагин заголовков — гард по исходнику (server/** тестами не покрывается)', () => {
  const src = readFileSync(resolve(process.cwd(), 'server/plugins/security-headers.ts'), 'utf8')

  it('использует хук ответа, а не middleware: иначе статика уходит без заголовков', () => {
    // Проверено вживую: у middleware `/favicon.svg` отдавался вообще без CSP — обработчик публичных
    // файлов в Nitro стоит ПЕРЕД сканированными middleware.
    expect(src).toContain("hooks.hook('beforeResponse'")
    expect(src).toContain('setResponseHeaders')
  })

  it('env не уходит в политику сырым — только через разбор', () => {
    expect(src).toContain('parseExtraFrameAncestors(process.env.CSP_FRAME_ANCESTORS)')
    expect(src).toContain('resolveCspMode(process.env.CSP_MODE)')
  })
})
