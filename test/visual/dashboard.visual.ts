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
  // Якоря нижних секций: тренд и срез по услугам отрисованы — снимок fullPage берёт их целиком.
  await expect(page.getByText('Динамика NPS по месяцам')).toBeVisible()
  await expect(page.getByText('По услугам')).toBeVisible()
  await expect(page).toHaveScreenshot('dashboard.png', { fullPage: true })
})

test('дашборд (фильтр по версии) совпадает с эталоном', async ({ page }) => {
  // Деплинк `?version=1` → SSR-срез по версии (без клика — детерминированно). На срезе v1
  // услуги подавлены (каждый продукт < порога внутри версии) — карточки «По услугам» нет.
  await page.goto(`/d/${SURVEY_KEY}?version=1`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByText('Ответов: 6')).toBeVisible() // срез применён (v1 = 6 ответов)
  await expect(page.getByText('Динамика NPS по месяцам')).toBeVisible() // нижняя секция отрисована
  await expect(page).toHaveScreenshot('dashboard-version.png', { fullPage: true })
})

test('клик по селектору версии меняет срез (URL + данные)', async ({ page }) => {
  // Постоянный e2e интерактивного пути (без скриншота): navigateTo → URL → useAsyncData рефетч.
  await page.goto(`/d/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await expect(page.getByText('Ответов: 12')).toBeVisible()

  await page.getByRole('button', { name: 'Версия 1', exact: true }).click()
  await expect(page).toHaveURL(/version=1/)
  await expect(page.getByText('Ответов: 6')).toBeVisible() // срез применён по клику

  await page.getByRole('button', { name: 'Все', exact: true }).click()
  await expect(page).not.toHaveURL(/version=/)
  await expect(page.getByText('Ответов: 12')).toBeVisible() // вернулись ко всем версиям
})

test('дашборд (опрос не найден) совпадает с эталоном', async ({ page }) => {
  // SSR-fetch /api/dashboard/nonexistent → 404 → useAsyncData.error → алерт (реальный путь, без моков).
  await page.goto('/d/nonexistent-survey', { waitUntil: 'networkidle' })
  await expect(page.getByText('Не удалось загрузить дашборд.')).toBeVisible()
  await expect(page).toHaveScreenshot('dashboard-error.png', { fullPage: true })
})
