import { defineConfig, devices } from '@playwright/test'

/**
 * Детерминированный визуальный гейт (issue #13). Стратегия: render → screenshot →
 * сверка с эталоном (`toHaveScreenshot`); расхождение пикселей выше порога = провал.
 * Гейт активируется Stop-хуком (`.claude/hooks/visual-gate.sh`) на изменениях UI.
 *
 * Детерминизм (иначе скриншоты «плывут» и гейт бесполезен):
 * - `reducedMotion: 'reduce'` + `animations: 'disabled'` — без анимаций/переходов;
 * - фиксированные вьюпорты-брейкпоинты (десктоп/мобайл) как ОТДЕЛЬНЫЕ проекты —
 *   эталон на каждый брейкпоинт (десктоп-рейл скрыт на мобайле и т.п., docs/design.md §8);
 * - system-шрифты в фикстурах (без веб-фонтов) — чтобы рендер не зависел от загрузки сети.
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
    env: { PORT: '3030' }
  },
  use: {
    baseURL: 'http://127.0.0.1:3030',
    reducedMotion: 'reduce',
    // colorScheme зафиксирован светлым (детерминизм). Тёмная тема (#34) —
    // отдельными проектами с colorScheme:'dark', когда у b24ui-экранов будет dark.
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
    }
  ]
})
