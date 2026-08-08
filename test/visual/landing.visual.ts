import { test, expect } from '@playwright/test'
import { SURVEY_KEY } from '../../src/demo/seed'
import { LANDING_STATUS, LANDING_TITLE } from '../../app/utils/landing'

/**
 * Визуальный гейт лендинга (`/`) — публичной витрины. Отдельная спека от контуров A и B: у страницы
 * своя задача (продать) и свой набор рисков.
 *
 * Под гейт она попадает только потому, что построена **детерминированной**: без анимаций, QR и
 * счётчиков (образец соседнего проекта их использует — от них отказались осознанно, см. комментарий
 * в `app/pages/index.vue`). Данных страница не грузит вовсе, поэтому снимок зависит только от вёрстки.
 *
 * Зачем гейт именно здесь: лендинг — единственный экран, который увидит покупатель до установки, а
 * тексты приходят из `app/utils/landing.ts` и кормят ещё и обложку для соцсетей. Молчаливая поломка
 * тут стоит дороже, чем на внутреннем экране. Первый же рендер это подтвердил: в тёмной теме H1 и все
 * H2 были не видны вовсе (голые заголовки без цвета), а страница выглядела «почти рабочей».
 */
test('лендинг совпадает с эталоном', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  // Нижний якорь — ссылка ФУТЕРА, а не последний заголовок: снимок fullPage берёт страницу целиком,
  // значит готовым должен быть её самый низ. Ищем внутри ориентира `contentinfo` — заодно это
  // проверяет, что `footer` вынесен из `main` (внутри него ориентира не возникает).
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Посмотреть демо-опрос' })).toBeVisible()
  // Тема прогружена: у тёмных профилей оба текстовых якоря одинаковы, и медленный флип `.dark`
  // дал бы светлый снимок в тёмном эталоне.
  await expect(page.locator('html')).toHaveAttribute('class', /light|dark/)
  await expect(page).toHaveScreenshot('landing.png', { fullPage: true })
})

test('витрина отдаёт корректные мета-теги для превью', async ({ page }) => {
  // Без скриншота: `<title>` и og в снимок не попадают, а удалённый og.png или правка адреса
  // ломают превью в Маркете и мессенджерах молча.
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page).toHaveTitle(LANDING_TITLE)
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/og\.png$/)
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1)
  const og = await page.locator('meta[property="og:image"]').getAttribute('content')
  const res = await page.request.get(og!)
  expect(res.status(), 'og:image не отдаётся').toBe(200)
})

test('главное действие страницы работает и статус виден', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })

  // Пока приложение не в Маркете, посетитель должен видеть статус, а ссылки на карточку Маркета
  // быть НЕ должно. Проверяем по адресу, а не по роли: `B24Button` с `to` рендерит <a>, то есть
  // проверка «нет кнопки с таким именем» проходила бы и при включённом флаге — то есть никогда.
  await expect(page.getByText(LANDING_STATUS)).toBeVisible()
  await expect(page.locator('a[href*="bitrix24.ru/apps/app"]')).toHaveCount(0)

  // CTA обязан быть ССЫЛКОЙ: <button> не пройдёт краулер и не откроется в новой вкладке.
  const cta = page.getByRole('main').getByRole('link', { name: 'Посмотреть демо-опрос' })
  await expect(cta).toHaveAttribute('href', `/s/${SURVEY_KEY}`)
  await cta.click()
  await expect(page).toHaveURL(new RegExp(`/s/${SURVEY_KEY}$`))
  await expect(page.getByRole('button', { name: 'Начать', exact: true })).toBeVisible()
})
