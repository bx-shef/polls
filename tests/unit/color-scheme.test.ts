import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Гвард: приложение светлое принудительно, и ровно одна страница — нет.
 *
 * ⚠ От чего он появился. До 24.09 палитра в `app/app.vue` переключалась по
 * `prefers-color-scheme`, и это было тёмной темой ровно наполовину: набор `b24ui`
 * системную тему НЕ слушает вовсе — его тёмный вариант включается классом `.dark`,
 * которого у нас не ставит никто. То есть у сотрудника с тёмной системой наши
 * собственные фон и текст темнели, а все компоненты набора поверх них оставались
 * светлыми. Владелец решил вопрос в одну сторону: светлая тема, и только она.
 *
 * Гвард держит два разных отказа, и оба не видно при беглом чтении дифа:
 *
 * 1. Вернувшийся `prefers-color-scheme` в любом файле `app/` — это возврат ровно
 *    того половинчатого состояния.
 * 2. Пропавший `color-scheme: light` — это НЕ возврат к прежнему, а хуже: браузер
 *    на тёмной системе продолжит красить своё (полосы прокрутки, выпадающие списки,
 *    календарь, автозаполнение) тёмным поверх белой страницы.
 */

const appDir = fileURLToPath(new URL('../../app', import.meta.url))

/** Единственное место, которому тёмная схема разрешена, и почему. */
const DARK_ON_PURPOSE: Record<string, string> = {
  'pages/s/[token].vue': 'публичная анкета: фирменный бланк заказчика, тёмный по макету',
}

function findSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return findSources(full)
    return /\.(vue|css|ts)$/.test(entry) ? [full] : []
  })
}

const sources = findSources(appDir).map(full => ({
  name: relative(appDir, full).replaceAll('\\', '/'),
  text: readFileSync(full, 'utf8'),
}))

describe('тема приложения', () => {
  it('в дереве вообще есть что проверять', () => {
    // ⚠ Без этого тест остаётся зелёным после переименования каталога: пустой список
    // проходит любой `every`. Самый частый способ незаметно выключить такой гвард.
    expect(sources.length).toBeGreaterThanOrEqual(5)
  })

  it('корень объявляет светлую схему явно', () => {
    // ⚠ ГЛАВНЫЙ ГВАРД ФАЙЛА. Удаления тёмного блока НЕ достаточно: без явного значения
    // браузер берёт системное и красит им свою часть интерфейса. Тёмная полоса прокрутки
    // вдоль белой страницы выглядит как поломка вёрстки, а причина у неё в одной строке.
    const root = sources.find(source => source.name === 'app.vue')!

    expect(root.text).toContain('color-scheme: light;')
  })

  it.each(sources.filter(source => !(source.name in DARK_ON_PURPOSE)).map(source => source.name))(
    '%s не переключает палитру по системной теме',
    (name) => {
      const source = sources.find(candidate => candidate.name === name)!

      // ⚠ Ищем ПРАВИЛО, а не слово: разбор решения живёт в комментариях рядом с кодом,
      // и гвард, спотыкающийся об объяснение самого себя, чинят удалением объяснения.
      expect(source.text).not.toMatch(/@media[^{]*prefers-color-scheme/)
    },
  )

  it.each(sources.filter(source => source.name.startsWith('pages/')).map(source => source.name))(
    '%s держит свои стили при себе',
    (name) => {
      // ⚠ Поймано при этой же правке. Фон холста берётся с `body`, а `scoped`-стиль до него
      // не дотягивается — рука тянется написать глобальный блок. Он остаётся загруженным
      // и после ухода со страницы, а «очевидное» условие `body:has(.page)` красит заодно
      // лендинг: у него корень тоже `<main class="page">`. Нужен `body` — есть `bodyAttrs`
      // в `useHead`, он живёт ровно пока открыт маршрут.
      const source = sources.find(candidate => candidate.name === name)!

      for (const tag of source.text.match(/<style[^>]*>/g) ?? []) {
        expect(tag, `${name}: глобальный <style> на странице`).toContain('scoped')
      }
    },
  )

  it('публичная анкета остаётся тёмной — и на корне, и внутри листа', () => {
    // ⚠ Две строки, а не одна, и это не дубль. Полосу прокрутки документа браузер красит
    // по схеме КОРНЯ — её ставит `useHead`; каретку, выделение и поля внутри листа — по
    // схеме элемента. Убери любую — и на тёмном бланке появится светлая деталь,
    // которую в коде не видно, а на экране видно сразу.
    const page = sources.find(source => source.name === 'pages/s/[token].vue')

    expect(page, 'страница анкеты исчезла — поправьте список').toBeDefined()
    expect(page!.text).toContain(`htmlAttrs: { style: 'color-scheme: dark' }`)
    expect(page!.text).toContain('color-scheme: dark;')
  })
})
