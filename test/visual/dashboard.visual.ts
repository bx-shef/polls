import { test, expect } from '@playwright/test'
import { SURVEY_KEY } from '../../src/demo/seed'

/**
 * Визуальный гейт дашборда (контур B, #34/#13) — живые маршруты `/d/:key`, нативная тема b24ui.
 * Данные — серверный агрегат над детерминированным демо-сидом (domain/aggregate). Отдельная
 * спека от контура A (`screens.visual.ts`); проекты (3 брейкпоинта × 2 темы) — общие из конфига.
 *
 * Детерминизм: дашборд читает ОБЩИЙ стор (SSR, живой агрегат), поэтому опирается на инвариант
 * «гейт-тесты НЕ пишут ответы» — submit в thanks/submit-error замокан. Не добавляйте в гейт
 * тест с реальным submit, иначе число ответов «поплывёт».
 *
 * Состояние «мало ответов» (suppressed) пока не под гейтом: нужен опрос с n<5, а seed — 12
 * (а data-fetch SSR, page.route его не перехватит). Покрытие suppressed — отдельный слайс (#49).
 */
test('дашборд совпадает с эталоном', async ({ page }) => {
  await page.goto(`/d/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page).toHaveScreenshot('dashboard.png', { fullPage: true })
})

test('дашборд (опрос не найден) совпадает с эталоном', async ({ page }) => {
  // SSR-fetch /api/dashboard/nonexistent → 404 → useAsyncData.error → алерт (реальный путь, без моков).
  await page.goto('/d/nonexistent-survey', { waitUntil: 'networkidle' })
  await expect(page.getByText('Не удалось загрузить дашборд.')).toBeVisible()
  await expect(page).toHaveScreenshot('dashboard-error.png', { fullPage: true })
})
