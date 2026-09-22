import { describe, expect, it } from 'vitest'
import { addNonceToScripts, createNonce } from '../../server/utils/csp-nonce'

/**
 * Простановка nonce в разметку.
 *
 * Самое опасное место всей правки. Ошибка здесь бьёт с двух сторон: не поставили nonce —
 * страница не оживёт у респондента; поставили не туда — испортили блок payload, а в нём
 * лежит текст анкеты, который писал сотрудник портала.
 */

const NONCE = 'AbC+123/xyz=='

describe('сам nonce', () => {
  it('разный на каждый вызов', () => {
    // ⚠ Предсказуемый nonce — это отсутствующий nonce: зная его, инъекция просто подставит
    // его себе и политика пропустит скрипт.
    const seen = new Set(Array.from({ length: 50 }, () => createNonce()))

    expect(seen.size).toBe(50)
  })

  it('не меньше 128 бит', () => {
    // Минимум по спецификации CSP.
    expect(Buffer.from(createNonce(), 'base64')).toHaveLength(16)
  })

  it('не ломает ни атрибут, ни заголовок', () => {
    // base64 даёт `+`, `/` и `=` — все законны и в значении атрибута, и в директиве CSP.
    // А вот кавычка или `;` разорвали бы одно из двух.
    for (let i = 0; i < 100; i++) expect(createNonce()).toMatch(/^[A-Za-z0-9+/=]+$/)
  })
})

describe('простановка в разметку', () => {
  it('ставит nonce исполняемому инлайновому скрипту', () => {
    expect(addNonceToScripts('<script>window.__NUXT__={}</script>', NONCE))
      .toBe(`<script nonce="${NONCE}">window.__NUXT__={}</script>`)
  })

  it('ставит nonce importmap и внешнему модулю', () => {
    // Оба встречаются на собранной странице: проверено на `.output` 22.09.
    const html = '<script type="importmap">{"imports":{}}</script><script type="module" src="/_nuxt/a.js"></script>'

    expect(addNonceToScripts(html, NONCE)).toBe(
      `<script nonce="${NONCE}" type="importmap">{"imports":{}}</script>`
      + `<script nonce="${NONCE}" type="module" src="/_nuxt/a.js"></script>`,
    )
  })

  it('НЕ лезет внутрь тела скрипта, даже если там написано `<script`', () => {
    // ⚠ ГЛАВНЫЙ ГВАРД ФАЙЛА. В блоке payload лежит текст анкеты, который писал сотрудник
    // портала. Слепая замена по строке вставила бы атрибут внутрь JSON: страница не ожила бы,
    // а сломанная разметка — это сам по себе способ вылезти за границы тега.
    const html = '<script type="application/json">{"title":"как писать &lt;script alert(1)"}</script>'
    const done = addNonceToScripts(html, NONCE)

    expect(done).toBe(`<script nonce="${NONCE}" type="application/json">{"title":"как писать &lt;script alert(1)"}</script>`)
    // Ровно одна простановка: внутрь тела не залезли.
    expect(done.split('nonce=')).toHaveLength(2)
  })

  it('литеральный `<script` в теле не получает атрибут и не сдвигает разбор', () => {
    // Тот же случай без экранирования: даже так атрибут не должен уехать в текст,
    // а следующий НАСТОЯЩИЙ тег обязан быть найден.
    const html = '<script>var s = "<script foo"</script><script>b()</script>'
    const done = addNonceToScripts(html, NONCE)

    expect(done.split('nonce=')).toHaveLength(3)
    expect(done).toContain('var s = "<script foo"')
    expect(done).toContain(`<script nonce="${NONCE}">b()</script>`)
  })

  it('не трогает тег, у которого nonce уже есть', () => {
    // Разметка могла прийти с nonce от другого слоя; второй атрибут — сломанный тег.
    const html = `<script nonce="старый">a()</script>`

    expect(addNonceToScripts(html, NONCE)).toBe(html)
  })

  it('не принимает за скрипт тег с похожим именем', () => {
    // Без проверки следующего символа атрибут уехал бы в чужой тег.
    expect(addNonceToScripts('<scripting>текст</scripting>', NONCE)).toBe('<scripting>текст</scripting>')
  })

  it('разметку без скриптов отдаёт как есть', () => {
    expect(addNonceToScripts('<div>всё хорошо</div>', NONCE)).toBe('<div>всё хорошо</div>')
    expect(addNonceToScripts('', NONCE)).toBe('')
  })

  it('обрывок разметки не теряется и не падает', () => {
    // Разметку нам даёт Nuxt, но потерять хвост при любой её форме нельзя:
    // страница уехала бы к респонденту обрезанной.
    expect(addNonceToScripts('<script', NONCE)).toBe('<script')
    expect(addNonceToScripts('<script>без закрытия', NONCE)).toBe(`<script nonce="${NONCE}">без закрытия`)
    expect(addNonceToScripts('текст <script foo', NONCE)).toBe('текст <script foo')
  })

  it('ставит nonce каждому из нескольких скриптов подряд', () => {
    const html = '<script>a()</script>\n<div>x</div>\n<script src="/b.js"></script>'
    const done = addNonceToScripts(html, NONCE)

    expect(done.split(`nonce="${NONCE}"`)).toHaveLength(3)
    expect(done).toContain('<div>x</div>')
  })
})
