import { test, expect } from '@playwright/test'
import { SURVEY_KEY } from '../../src/demo/seed'

/**
 * Визуальный гейт дашборда (контур B, #34/#13) — живой маршрут `/d/:key`, нативная тема b24ui.
 * Данные — серверный агрегат над детерминированным демо-сидом (domain/aggregate). Отдельная
 * спека от контура A (`screens.visual.ts`); проекты (3 брейкпоинта × 2 темы) — общие из конфига.
 *
 * Детерминизм: дашборд читает ОБЩИЙ стор (SSR, живой агрегат), поэтому опирается на инвариант
 * «гейт-тесты НЕ пишут ответы» — submit в thanks/submit-error замокан. Не добавляйте в гейт
 * тест с реальным submit, иначе число ответов «поплывёт».
 */
test('дашборд совпадает с эталоном', async ({ page }) => {
  await page.goto(`/d/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page).toHaveScreenshot('dashboard.png', { fullPage: true })
})
