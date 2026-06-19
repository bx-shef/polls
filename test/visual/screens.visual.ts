import { test, expect, type Page } from '@playwright/test'

/**
 * Визуально проверяемые «поверхности» контура A (issue #13/#39/#34) — ЖИВЫЕ маршруты
 * приложения (webServer + baseURL в playwright.config), реальный SSR-рендер b24ui на
 * детерминированном демо-сиде (`demo/seed.ts`).
 *
 * intro — прямой рендер; survey/thanks — через управляющую навигацию (клик «Начать»,
 * прохождение happy-path); error — несуществующий опрос (404 → алерт). Дальше (#34):
 * состояния загрузка/пусто, тёмная тема — отдельными проектами/поверхностями.
 */
const KEY = 'csat_postdeal'

test('экран «intro» совпадает с эталоном', async ({ page }) => {
  await page.goto(`/s/${KEY}`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('button', { name: 'Начать' })).toBeVisible()
  await expect(page).toHaveScreenshot('intro.png', { fullPage: true })
})

test('экран «survey» (первый вопрос) совпадает с эталоном', async ({ page }) => {
  await page.goto(`/s/${KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать' }).click()
  // Чистый первый вопрос (до ответа) — детерминированный снимок шкалы NPS + прогресса.
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible()
  await expect(page).toHaveScreenshot('survey.png', { fullPage: true })
})

test('экран «thanks» совпадает с эталоном', async ({ page }) => {
  await page.goto(`/s/${KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать' }).click()
  await answerHappyPath(page)
  await expect(page.getByText('Спасибо за ответы!')).toBeVisible()
  await expect(page).toHaveScreenshot('thanks.png', { fullPage: true })
})

test('экран «error» (опрос не найден) совпадает с эталоном', async ({ page }) => {
  await page.goto('/s/nonexistent-survey', { waitUntil: 'networkidle' })
  await expect(page.getByText(/не найден/i)).toBeVisible()
  await expect(page).toHaveScreenshot('error.png', { fullPage: true })
})

/** Пройти happy-path: на каждом шаге выбрать первый вариант (или пропустить text) → Далее/Отправить. */
async function answerHappyPath(page: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const radio = page.getByRole('radio').first()
    const checkbox = page.getByRole('checkbox').first()
    if (await radio.count()) await radio.click({ force: true })
    else if (await checkbox.count()) await checkbox.click({ force: true })
    const submit = page.getByRole('button', { name: 'Отправить' })
    if (await submit.count()) { await submit.click(); return }
    await page.getByRole('button', { name: 'Далее' }).click()
    await page.waitForTimeout(100) // дать перерисоваться следующему вопросу
  }
}
