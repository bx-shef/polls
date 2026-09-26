import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Гвард: портальная страница обязана назвать свой layout.
 *
 * ⚠ Умолчания (`layouts/default.vue`) у нас нет намеренно, и цена этого решения — ровно
 * этот тест. Забыв `definePageMeta({ layout: 'portal' })`, новая портальная страница
 * отрендерится БЕЗ `<B24App>`: без темы, без локали, без тостов и оверлеев набора.
 * Снаружи это выглядит не как поломка, а как «что-то поехало» — компоненты на месте,
 * просто ведут себя иначе, — и находится такое не раньше, чем в портале у клиента.
 *
 * Разделение здесь по КАТАЛОГУ, а не по списку имён: список надо помнить, каталог виден.
 * Своя вёрстка ровно у двух страниц, и обе — отдельные миры. Справка (`help.vue`) тоже публичная,
 * но носит портальный layout: внутри портала её показывают в слайдере — разбор в `layouts/portal.vue`.
 */

const pagesDir = fileURLToPath(new URL('../../app/pages', import.meta.url))

/**
 * Страницы, которым layout НЕ нужен, и почему.
 *
 * ⚠ Список именно такой формы — путь плюс причина, — чтобы добавить сюда что-то молча
 * было неудобно: новая строка требует объяснения, а объяснение требует решения.
 */
const OUTSIDE_PORTAL: Record<string, string> = {
  'index.vue': 'лендинг: публичная страница со своей вёрсткой, её читает поисковик',
  's/[token].vue': 'публичная анкета: отдельный мир, тёмный лист заказчика и свой CSP',
}

function findPages(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? findPages(full) : full.endsWith('.vue') ? [full] : []
  })
}

const pages = findPages(pagesDir).map(full => ({
  name: relative(pagesDir, full).replaceAll('\\', '/'),
  source: readFileSync(full, 'utf8'),
}))

describe('layout портальных страниц', () => {
  it('в дереве вообще есть страницы — иначе проверка ничего не проверяет', () => {
    // ⚠ Без этого тест остаётся зелёным, если каталог переименуют: пустой список
    // проходит любой `every`. Самый частый способ незаметно выключить такой гвард.
    expect(pages.length).toBeGreaterThanOrEqual(4)
  })

  it.each(pages.filter(page => !(page.name in OUTSIDE_PORTAL)).map(page => page.name))(
    '%s объявляет layout `portal`',
    (name) => {
      const page = pages.find(candidate => candidate.name === name)!

      expect(page.source).toContain(`definePageMeta({ layout: 'portal' })`)
    },
  )

  it.each(Object.keys(OUTSIDE_PORTAL))('%s остаётся вне портального layout', (name) => {
    // Обратная сторона: портальная оболочка на публичной странице — это `<B24App>`
    // с его темами и стилями поверх чужого дизайна. Заметно сразу, чинится долго.
    const page = pages.find(candidate => candidate.name === name)

    expect(page, `страница ${name} исчезла — поправьте список`).toBeDefined()
    expect(page!.source).not.toContain(`layout: 'portal'`)
  })
})
