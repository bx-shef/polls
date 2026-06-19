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
  use: {
    reducedMotion: 'reduce',
    colorScheme: 'light'
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      // ~0.2% пикселей — запас на антиалиасинг текста, не на регрессию раскладки.
      maxDiffPixelRatio: 0.002
    }
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
    },
    {
      name: 'mobile',
      // Брейкпоинт мобайла (docs/design.md §8: рейл скрыт, нав прилипает к низу, 1 колонка).
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } }
    }
  ]
})
