import { test, expect, type Page } from '@playwright/test'
import { SURVEY_KEY } from '../../src/demo/seed'

/**
 * Визуально проверяемые «поверхности» контура A (issue #13/#39/#34) — ЖИВЫЕ маршруты
 * приложения (webServer + baseURL в playwright.config), реальный SSR-рендер b24ui на
 * детерминированном демо-сиде (`demo/seed.ts`; ключ опроса — оттуда же, без рассинхрона).
 *
 * intro — прямой рендер; survey/thanks — через управляющую навигацию (клик «Начать»,
 * прохождение happy-path); error — несуществующий опрос (404 → алерт); submit-error —
 * happy-path с замоканным провалом POST /api/submit (алерт ошибки на экране опроса). Снимок
 * не раньше якоря готовности рендера (visible-локатор), без жёстких sleep.
 *
 * Состояния «загрузка»/«пусто» отдельно НЕ гейтятся: loading недостижим на первом paint
 * (SSR `await useAsyncData` + `watch immediate` ставят фазу до рендера), «пусто» = 404
 * (уже покрыт `error`). Ручной тоггл темы — #45.
 */
test('экран «intro» совпадает с эталоном', async ({ page }) => {
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('button', { name: 'Начать', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('intro.png', { fullPage: true })
})

test('экран «survey» (первый вопрос) совпадает с эталоном', async ({ page }) => {
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  // Якорь после клика: первый вопрос отрисован (контролы готовы) — снимок не раньше.
  await expect(page.getByRole('radio').first()).toBeVisible()
  await expect(page).toHaveScreenshot('survey.png', { fullPage: true })
})

test('экран «thanks» совпадает с эталоном', async ({ page }) => {
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  await answerHappyPath(page)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page).toHaveScreenshot('thanks.png', { fullPage: true })
})

test('экран «error» (опрос не найден) совпадает с эталоном', async ({ page }) => {
  await page.goto('/s/nonexistent-survey', { waitUntil: 'networkidle' })
  await expect(page.getByText('Опрос не найден или больше не активен.')).toBeVisible()
  await expect(page).toHaveScreenshot('error.png', { fullPage: true })
})

test('экран «submit-error» (провал отправки) совпадает с эталоном', async ({ page }) => {
  // Мокаем провал ТОЛЬКО POST /api/submit (клиентский $fetch) → ядро остаётся, экран опроса
  // показывает алерт ошибки. GET survey/current (SSR) не трогаем.
  await page.route('**/api/submit', (route) => route.fulfill({ status: 500, body: '{"ok":false}' }))
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  await answerHappyPath(page) // дойдёт до «Отправить» и кликнет — submit упадёт (мок)
  await expect(page.getByText(/Не удалось отправить/)).toBeVisible()
  await expect(page).toHaveScreenshot('submit-error.png', { fullPage: true })
})

const PROGRESS = /Вопрос (\d+) из (\d+)/

/**
 * Пройти happy-path: на каждом шаге заполнить ответ (первый вариант / любой текст) → Далее.
 * Граница цикла — реальное число вопросов из счётчика (не магическая константа). Переход
 * ждём по СМЕНЕ счётчика «Вопрос N из M» (детерминированный барьер, без sleep).
 */
async function answerHappyPath(page: Page): Promise<void> {
  const counter = page.getByText(PROGRESS)
  await expect(counter).toBeVisible()
  const total = Number(PROGRESS.exec((await counter.textContent()) ?? '')?.[2] ?? 0) || 1

  for (let step = 0; step < total; step++) {
    const radio = page.getByRole('radio').first()
    const checkbox = page.getByRole('checkbox').first()
    const textbox = page.getByRole('textbox').first()
    if (await radio.count()) await radio.click({ force: true })
    else if (await checkbox.count()) await checkbox.click({ force: true })
    else if (await textbox.count()) await textbox.fill('ok')

    const submit = page.getByRole('button', { name: 'Отправить', exact: true })
    if (await submit.count()) { await submit.click(); return }

    const prev = await counter.textContent()
    await page.getByRole('button', { name: 'Далее', exact: true }).click()
    await expect(counter).not.toHaveText(prev ?? '') // следующий вопрос отрисован
  }
  throw new Error('answerHappyPath: цикл исчерпан, кнопка «Отправить» не достигнута')
}
