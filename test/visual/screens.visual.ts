import { test, expect } from '@playwright/test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Реестр визуально проверяемых «поверхностей» контура A (issue #13).
 *
 * Сейчас — статические фикстуры-заглушки (Nuxt/b24ui-слоя ещё нет): гейт доказан
 * end-to-end ДО появления экранов, как и просили («экраны сразу под гейтом»). Когда
 * появится Nuxt-приложение — заменим `file://`-фикстуры на `baseURL` + реальные
 * маршруты (`/s/:key` и т.п.), добавим состояния (пусто/ошибка/загрузка) и тёмную тему;
 * структура реестра и сами эталоны на брейкпоинты (desktop/mobile проекты) останутся.
 */
const SURFACES = [
  { name: 'intro', file: 'intro.placeholder.html' }
] as const

for (const surface of SURFACES) {
  test(`экран «${surface.name}» совпадает с эталоном`, async ({ page }) => {
    await page.goto(pathToFileURL(join(here, 'fixtures', surface.file)).href)
    // Полностраничный снимок: ловит регрессии раскладки целиком, не только вьюпорта.
    await expect(page).toHaveScreenshot(`${surface.name}.png`, { fullPage: true })
  })
}
