import { test, expect } from '@playwright/test'

/**
 * Реестр визуально проверяемых «поверхностей» контура A (issue #13/#39).
 *
 * Теперь — ЖИВЫЕ маршруты приложения (webServer + baseURL в playwright.config), а не
 * статические фикстуры: гейт сторожит реальный SSR-рендер b24ui-экранов на детерминированном
 * демо-сиде (`demo/seed.ts`). Дальше (#34): состояния (survey/thanks/пусто/ошибка/загрузка),
 * тёмная тема — отдельными поверхностями/проектами.
 */
const SURFACES = [
  { name: 'intro', path: '/s/csat_postdeal' }
] as const

for (const surface of SURFACES) {
  test(`экран «${surface.name}» совпадает с эталоном`, async ({ page }) => {
    await page.goto(surface.path, { waitUntil: 'networkidle' })
    // Якорь готовности рендера — заголовок интро (снимок не раньше, чем он виден).
    await expect(page.locator('h1')).toBeVisible()
    await expect(page).toHaveScreenshot(`${surface.name}.png`, { fullPage: true })
  })
}
