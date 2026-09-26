import { describe, expect, it } from 'vitest'
import { buildHelpPageCsp, buildPublicPageCsp, needsNonce, portalCsp, securityHeadersFor } from '../../server/utils/security-headers'

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

/** Политика публичной страницы без nonce — её форма проверяется прежними тестами. */
const publicPageCsp = buildPublicPageCsp()

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

  it('лендингу — публичную, и он единственный индексируется', () => {
    // Корень живёт вне портала и в выдаче ему место. Всё остальное — служебные страницы.
    expect(securityHeadersFor('/')['Content-Security-Policy']).toBe(publicPageCsp)
    expect(securityHeadersFor('/')['X-Robots-Tag']).toBeUndefined()
  })

  it('страницам приложения — портальную и noindex', () => {
    // ⚠ Гвард под ошибку, оплаченную соседним проектом: служебная страница без `noindex`
    // ушла в индекс С МЕТА-ДАННЫМИ ЛЕНДИНГА, и по запросу про продукт выдача показывала
    // пустую панель, которая снаружи портала не работает в принципе.
    for (const path of ['/app', '/install', '/portal/deal-tab']) {
      expect(securityHeadersFor(path)['Content-Security-Policy']).toBe(portalCsp)
      expect(securityHeadersFor(path)['X-Robots-Tag']).toBe('noindex, nofollow')
    }
  })

  it('справке и её тексту для ИИ-помощника — публичную политику и место в выдаче', () => {
    // Справку читают снаружи портала: модератор Маркета, поиск, человек по ссылке.
    expect(securityHeadersFor('/help')['Content-Security-Policy']).toBe(buildHelpPageCsp())
    expect(securityHeadersFor('/llms.txt')['Content-Security-Policy']).toBe(publicPageCsp)
    for (const path of ['/help', '/llms.txt']) expect(securityHeadersFor(path)['X-Robots-Tag']).toBeUndefined()
    expect(needsNonce('/help')).toBe(true)
    expect(securityHeadersFor('/help', 'abc')['Content-Security-Policy']).toContain(`'nonce-abc'`)
  })

  it('справку портал встроить может, а инлайновые скрипты ей по-прежнему нельзя', () => {
    // ⚠ При полной перезагрузке фрейма после выката адресом документа в слайдере становится `/help`,
    // и `frame-ancestors 'none'` дал бы пустой слайдер. Нашли `/review` и `/code-review` в PR #82.
    const help = buildHelpPageCsp('abc')
    expect(directive(help, 'frame-ancestors')).toBe(directive(portalCsp, 'frame-ancestors'))
    expect(directive(help, 'script-src')).toBe(`script-src 'self' 'nonce-abc'`)
  })

  it('справку по /help/ и /HELP отдаёт под той же политикой', () => {
    // ⚠ Роутер отдаёт эти адреса той же страницей; без нормализации она уходила под портальную
    // политику с `unsafe-inline`. Нашёл `/review` запросом к собранному приложению.
    for (const path of ['/help/', '/HELP', '/help?x=1']) {
      expect(securityHeadersFor(path)['Content-Security-Policy'], path).toBe(buildHelpPageCsp())
    }
  })

  it('не путает справку с путями, которые с неё начинаются', () => {
    expect(securityHeadersFor('/helpdesk')['Content-Security-Policy']).toBe(portalCsp)
  })

  it('виджет поля в карточке портал может встроить', () => {
    // ⚠ Поле своего типа открывается во фрейме ВНУТРИ карточки, и `frame-ancestors 'none'`
    // публичной политики сделал бы его пустым прямоугольником — без единой ошибки на нашей
    // стороне. Путь не под `/portal/**`, поэтому проверяем его отдельно, а не надеемся на префикс.
    expect(securityHeadersFor('/uf/survey-result')['Content-Security-Policy']).toBe(portalCsp)
    expect(securityHeadersFor('/uf/survey-result')['X-Robots-Tag']).toBe('noindex, nofollow')
  })

  it('не путает лендинг с путём, который с него начинается', () => {
    // `startsWith('/')` накрыл бы всё приложение: с косой черты начинается любой путь.
    expect(securityHeadersFor('/app')['Content-Security-Policy']).not.toBe(publicPageCsp)
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

describe('nonce вместо unsafe-inline на публичной странице', () => {
  it('в `script-src` публичной страницы НЕТ `unsafe-inline`', () => {
    // ⚠ ГВАРД ИЗ issue #2, и он же главный здесь. Это единственная страница, где текст,
    // введённый сотрудником портала, читает посторонний человек. Первый рубеж — отсутствие
    // разметки вовсе; CSP страхует его, и с `unsafe-inline` этой страховки просто нет.
    expect(directive(buildPublicPageCsp('abc'), 'script-src')).not.toContain('unsafe-inline')
    expect(directive(buildPublicPageCsp(), 'script-src')).not.toContain('unsafe-inline')
  })

  it('nonce попадает в `script-src`, когда он есть', () => {
    expect(directive(buildPublicPageCsp('abc123'), 'script-src')).toBe(`script-src 'self' 'nonce-abc123'`)
  })

  it('БЕЗ nonce политика строже, а не слабее', () => {
    // ⚠ Обратный порядок («нет nonce — вернём `unsafe-inline`») означал бы, что любая ошибка
    // в протягивании nonce тихо возвращает дыру, ради закрытия которой всё и делалось.
    expect(directive(buildPublicPageCsp(), 'script-src')).toBe(`script-src 'self'`)
  })

  it('в портальную политику nonce НЕ попадает ни при каких условиях', () => {
    // ⚠ В CSP nonce и `unsafe-inline` взаимоисключающие: браузер игнорирует `unsafe-inline`,
    // как только в политике появился хоть один nonce. Добавив nonce «заодно и туда»,
    // мы бы молча погасили скрипты самого Битрикс24.
    expect(securityHeadersFor('/app', 'abc')['Content-Security-Policy']).toBe(portalCsp)
    expect(securityHeadersFor('/app', 'abc')['Content-Security-Policy']).not.toContain('nonce-')
    expect(needsNonce('/app')).toBe(false)
    expect(needsNonce('/api/s/x')).toBe(false)
  })

  it('nonce просят ровно те пути, что получают публичную политику', () => {
    // Иначе заголовок и разметка разъедутся: где-то nonce в политике без nonce в скриптах
    // (страница не оживёт), где-то наоборот (дыра осталась).
    for (const path of ['/s/abc', '/', '']) {
      expect(needsNonce(path), path).toBe(true)
      expect(securityHeadersFor(path, 'n')['Content-Security-Policy'], path).toContain(`'nonce-n'`)
    }
  })

  it('заголовок публичной страницы несёт именно тот nonce, что дали', () => {
    expect(securityHeadersFor('/s/abc', 'РОВНО-ЭТОТ')['Content-Security-Policy']).toContain(`'nonce-РОВНО-ЭТОТ'`)
  })
})
