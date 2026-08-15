import { test, expect, type Page } from '@playwright/test'
import { DEMO_INVITATION_TOKEN, DEMO_INVITATION_TOKEN_2, SURVEY_KEY } from '../../src/demo/seed'

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

test('тоггл темы (#45) флипает класс .dark', async ({ page }) => {
  // Нативный B24ColorModeButton меняет preference @nuxtjs/color-mode → класс на <html>.
  // Без скриншота: поведение клика (гейт-проекты уже снимают обе темы детерминированно).
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('button', { name: 'Начать', exact: true })).toBeVisible()
  // Локатор по aria-label (EN-хардкод B24ColorModeButton); видимость = color-mode гидратирован.
  const toggle = page.getByRole('button', { name: /Switch to (dark|light) mode/ })
  await expect(toggle).toBeVisible()
  const html = page.locator('html')
  const wasDark = await html.evaluate((el) => el.classList.contains('dark'))
  await toggle.click()
  await expect.poll(() => html.evaluate((el) => el.classList.contains('dark')), { timeout: 10_000 }).toBe(!wasDark)
})

test('экран «survey» (первый вопрос) совпадает с эталоном', async ({ page }) => {
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  // Якорь после клика: первый вопрос отрисован (контролы готовы) — снимок не раньше.
  await expect(page.getByRole('radio').first()).toBeVisible()
  await expect(page).toHaveScreenshot('survey.png', { fullPage: true })
})

test('экран «thanks» совпадает с эталоном', async ({ page }) => {
  // Мокаем session+submit УСПЕХОМ: экран «Спасибо» рендерится (phase→thanks), но реальный
  // ответ в стор НЕ пишется. Иначе гейт-прогон копит ответы в общем сторе и делает дашборд
  // (контур B, читает тот же стор) недетерминированным. Контент «Спасибо» статичен (из версии).
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 200, json: { nonce: 'test-nonce', schema_version: 1 } })
  )
  await page.route('**/api/submit', (route) => route.fulfill({ status: 200, json: { ok: true } }))
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  await answerHappyPath(page)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page).toHaveScreenshot('thanks.png', { fullPage: true })
})

test('экран «error» (опрос не найден) совпадает с эталоном', async ({ page }) => {
  // Текст — СЕРВЕРНЫЙ (`api.survey` → 404), не клиентская заготовка: страница обязана показывать
  // именно его, иначе респондент не узнает, что делать («попросите новую ссылку»).
  await page.goto('/s/nonexistent-survey', { waitUntil: 'networkidle' })
  await expect(page.getByText('Опрос не найден. Возможно, ссылка устарела — попросите новую.')).toBeVisible()
  await expect(page).toHaveScreenshot('error.png', { fullPage: true })
})

test('экран «ссылка не действует» совпадает с эталоном', async ({ page }) => {
  // Отдельный экран, а не «ошибка»: опрос жив, обновление страницы ничего не изменит, и
  // единственное осмысленное действие — попросить новую ссылку. Показывается ВМЕСТО интро, до
  // заполнения: раньше о негодной ссылке узнавали на «Отправить», когда работа уже сделана.
  // ⚠️ БЕЗ мока намеренно. Годность резолвится на SSR, куда `page.route` не достаёт вовсе — мок был
  // бы инертной строкой, создающей ложное впечатление, что тест ею управляет. Токен настоящим быть
  // не должен: сервер сам отвечает 403 на неизвестный, и это и есть проверяемый путь.
  await page.goto(`/s/${SURVEY_KEY}?token=протухший`, { waitUntil: 'networkidle' })
  await expect(page.getByText('По этой ссылке опрос не открыть')).toBeVisible()
  await expect(page).toHaveScreenshot('link-invalid.png', { fullPage: true })
})

test('токен из ссылки доезжает до submit — иначе ответ пишется без привязки к сделке', async ({ page }, testInfo) => {
  // Проверка ПРОВОДКИ, не вёрстки: в остальных пяти проектах она дала бы тот же результат за те же
  // секунды. Гейт и так поднимает сборку, а Stop-хук дёргает его на каждой правке UI.
  test.skip(testInfo.project.name !== 'desktop', 'проводка не зависит от темы и ширины')
  // Без скриншота: это проверка ПРОВОДКИ. Она же — единственное место, где ловится молчаливый
  // регресс «ответ принят, но контекст пуст»: сервер такой ответ примет и ничем не пожалуется.
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 200, json: { nonce: 'test-nonce', schema_version: 1 } })
  )
  let sentInvitation: unknown
  await page.route('**/api/submit', (route) => {
    sentInvitation = (route.request().postDataJSON() as Record<string, unknown>)['invitation']
    return route.fulfill({ status: 200, json: { ok: true } })
  })

  await page.goto(`/s/${SURVEY_KEY}?token=${DEMO_INVITATION_TOKEN}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  await answerHappyPath(page)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(sentInvitation, 'токен не доехал до тела запроса').toBe(DEMO_INVITATION_TOKEN)
})

test('другая ссылка на тот же опрос сбрасывает черновик — ответы не уедут к чужой сделке', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'проводка не зависит от темы и ширины')
  // Два приглашения — это две РАЗНЫЕ сделки. Перенести ответы из одного в другое значит привязать
  // оценку не к той сделке, а аналитика и есть продукт. Поэтому «потерять черновик» здесь дешевле.
  await page.goto(`/s/${SURVEY_KEY}?token=${DEMO_INVITATION_TOKEN}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  await page.getByRole('radio').first().click()
  // Прогресс сохранён: возврат по той же ссылке продолжает с места остановки.
  await page.goto(`/s/${SURVEY_KEY}?token=${DEMO_INVITATION_TOKEN}`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('radio').first()).toBeVisible()

  // А по ДРУГОЙ ссылке — начинаем с интро. Токен настоящий (демо заводит два приглашения на разные
  // сделки): мокать нельзя, годность проверяется на SSR, куда клиентский перехват не достаёт.
  await page.goto(`/s/${SURVEY_KEY}?token=${DEMO_INVITATION_TOKEN_2}`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('button', { name: 'Начать', exact: true })).toBeVisible()
})

test('причина отказа сервера доходит до респондента, ответы не пропадают', async ({ page }) => {
  // Без скриншота: это проверка ПРОВОДКИ, а не вёрстки (алерт уже под эталоном submit-error).
  // Сценарий достижимый именно из этого клиента: nonce не пережил перезапуск сервера → 403
  // «Страница устарела». Раньше клиент глотал ответ сервера и показывал «проверьте соединение» —
  // респондент шёл чинить интернет. Текст берём тот же, что отдаёт ядро (`src/api/handlers.ts`);
  // связку «ядро действительно отвечает этой формой» держит test/server-message.test.ts.
  const stale = 'Страница устарела. Обновите её и заполните опрос заново.'
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 200, json: { nonce: 'test-nonce', schema_version: 1 } })
  )
  await page.route('**/api/submit', (route) =>
    route.fulfill({ status: 403, json: { ok: false, error: stale } })
  )
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  await answerHappyPath(page)
  await expect(page.getByText(stale)).toBeVisible()

  // Второе обещание того же кода: снимок НЕ чистим — набранные ответы остаются при респонденте.
  // Без этой проверки «остаёмся на опросе» держалось только на комментарии.
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeVisible()
  const snapshot = await page.evaluate((k) => localStorage.getItem(k), `survey:${SURVEY_KEY}`)
  expect(snapshot, 'снимок прохождения стёрт — ответы респондента потеряны').not.toBeNull()
})

test('без ответа сервера показывается клиентский фолбэк', async ({ page }) => {
  // Вторая половина правила: текст пишет сервер, но когда ответа НЕТ (обрыв связи), строка наша.
  // После перевода ассертов на серверные тексты фолбэки не проверялись больше нигде.
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 200, json: { nonce: 'test-nonce', schema_version: 1 } })
  )
  await page.route('**/api/submit', (route) => route.abort('failed'))
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  await answerHappyPath(page)
  await expect(
    page.getByText('Не удалось отправить ответы. Проверьте подключение и попробуйте ещё раз.')
  ).toBeVisible()
})

// ⚠️ Парный фолбэк ЗАГРУЗКИ опроса («Не удалось открыть опрос…») гейтом не покрыт и покрыт быть не
// может: версию тянет `useAsyncData` на СЕРВЕРЕ, туда `page.route` не достаёт, а провал серверного
// запроса даёт тело с текстом — то есть другую ветку. Достижим он только при клиентской навигации
// между опросами, которой в интерфейсе пока нет.

test('экран «submit-error» (провал отправки) совпадает с эталоном', async ({ page }) => {
  // Изолируем именно провал submit: /api/session отдаём детерминированно (успех), а POST
  // /api/submit мокаем 500. Так тест «красный» только при реальной ошибке submit, а не из-за
  // чего-то до него. Оба — клиентские $fetch; GET survey/current (SSR) не трогаем.
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 200, json: { nonce: 'test-nonce', schema_version: 1 } })
  )
  await page.route('**/api/submit', (route) => route.fulfill({ status: 500, json: { ok: false } }))
  await page.goto(`/s/${SURVEY_KEY}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Начать', exact: true }).click()
  await answerHappyPath(page) // на «Отправить»: session (мок-успех) → submit (мок-500) → алерт
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
