import { defineConfig, devices } from '@playwright/test'

/**
 * Детерминированный визуальный гейт (issue #13/#39). Стратегия: render → screenshot →
 * сверка с эталоном (`toHaveScreenshot`); расхождение пикселей выше порога = провал.
 * Гейт активируется Stop-хуком (`.claude/hooks/visual-gate.sh`) на изменениях UI и снимает
 * ЖИВОЙ SSR-рендер приложения (`webServer` поднимает собранное `.output`).
 *
 * Детерминизм (иначе скриншоты «плывут» и гейт бесполезен):
 * - `reducedMotion: 'reduce'` + `animations: 'disabled'` — без анимаций/переходов;
 * - фиксированные вьюпорты-брейкпоинты как ОТДЕЛЬНЫЕ проекты — эталон на каждый
 *   (десктоп-рейл скрыт на мобайле и т.п., docs/design.md §8);
 * - детерминированный демо-сид (`demo/seed.ts`) + `waitUntil:'networkidle'` (ресурсы
 *   подгружены) + якорь-локатор visible (гидратация/рендер завершены) — снимок не раньше готовности;
 * - шрифты — системные (b24ui: CSS-переменные → `system-ui`), веб-фонтов нет → рендер не зависит от сети.
 *
 * Эталоны (`*.png`) коммитятся рядом со спеками и сверяются в той же среде
 * (предустановленный chromium в /opt/pw-browsers). Малый `maxDiffPixelRatio`
 * терпит субпиксельный антиалиасинг, но ловит реальные регрессии раскладки/цвета.
 */
export default defineConfig({
  testDir: './test/visual',
  // Визуальные спеки — *.visual.ts, чтобы НЕ пересекаться с vitest (`test/**/*.test.ts`).
  testMatch: '**/*.visual.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Жёсткий test-timeout: при зависшем networkidle/SSR падаем за 15с, не за дефолтные 30с
  // (быстрый выход Stop-хука). Интро рендерится <1с — запас огромный.
  timeout: 15_000,
  reporter: process.env.CI ? 'github' : [['list']],
  // Эталоны лежат предсказуемо: test/visual/__screenshots__/<spec>/<имя>-<project>.png
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{projectName}{ext}',
  // Гейт сторожит ЖИВОЙ SSR-рендер приложения (#39), а не фикстуры: поднимаем собранный
  // .output и снимаем реальные маршруты. `reuseExistingServer` локально переиспользует уже
  // запущенный `pnpm preview` (без пересборки); в CI/Stop-хуке — собирает и поднимает сам.
  // Готовность ждём по /api/health (Nitro). Сборка небыстрая — таймаут щедрый.
  webServer: {
    command: 'pnpm build && node .output/server/index.mjs',
    url: 'http://127.0.0.1:3030/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // NITRO_HOST=127.0.0.1 — сервер только на loopback (минимальная экспозиция: не 0.0.0.0).
    // PORT/host согласованы с url/baseURL. Локально reuseExistingServer переиспользует уже
    // запущенный сервер ТОЛЬКО на :3030 (`PORT=3030 DASHBOARD_DEV_OPEN=1 pnpm preview`), иначе соберёт сам.
    // DASHBOARD_DEV_OPEN=1 — открывает дашборд без auth (#47): собранный сервер бежит как
    // production, иначе гейт упрётся в 503 fail-closed. Боевой деплой флаг НЕ ставит (ставит секрет).
    env: { PORT: '3030', NITRO_HOST: '127.0.0.1', DASHBOARD_DEV_OPEN: '1' }
  },
  use: {
    baseURL: 'http://127.0.0.1:3030',
    reducedMotion: 'reduce',
    // Дефолт — светлая тема (детерминизм); dark-проекты ниже переопределяют `colorScheme:'dark'`.
    colorScheme: 'light'
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      // ~0.2% пикселей — запас на антиалиасинг текста, не на регрессию раскладки.
      maxDiffPixelRatio: 0.002
    }
  },
  // Три брейкпоинта по docs/design.md §8: десктоп (рейл ~38%), планшет 1024–1279
  // (та же 2-колоночная, рейл ~34%), мобайл (рейл скрыт, нав к низу, 1 колонка).
  // mobile — реальный mobile-профиль (Pixel 7: chromium-совместим, isMobile/hasTouch/
  // mobile-UA), чтобы media (hover:none)/(pointer:coarse) рендерились как на устройстве.
  // Каждый брейкпоинт — в светлой И тёмной теме (colorScheme → color-mode по prefers-color-scheme
  // флипает класс `.dark`, #34). dark-проекты дают отдельные эталоны `*-{bp}-dark.png`.
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } }
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] }
    },
    {
      name: 'desktop-dark',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, colorScheme: 'dark' }
    },
    {
      name: 'tablet-dark',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 }, colorScheme: 'dark' }
    },
    {
      name: 'mobile-dark',
      use: { ...devices['Pixel 7'], colorScheme: 'dark' }
    }
  ]
})
