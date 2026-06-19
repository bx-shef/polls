// Каркас Nuxt 4 для контура A (фаза связки). Ядро (движок/store/api) остаётся в `src/`
// и НЕ сканируется Nuxt: srcDir = `app/`, serverDir по умолчанию `server/` (его пока нет —
// Nitro-привязка `createApi` придёт следующим слайсом). Ядровой `pnpm check` независим.
//
// b24ui подключается модулем `@bitrix24/b24ui-nuxt` (Tailwind + air-токены внутри модуля).
// Доступ к типам/функциям ядра — через алиас `~core` на `src/` (без дублирования логики:
// Vue-композаблы оборачивают `SurveyFill` и зовут хендлеры, см. docs/design.md §1).
export default defineNuxtConfig({
  compatibilityDate: '2026-06-19',
  srcDir: 'app/',
  modules: ['@bitrix24/b24ui-nuxt'],
  // Контур A — публичный опрос (лендинг-подобный), SSR оправдан (быстрый first paint).
  ssr: true,
  devtools: { enabled: false },
  alias: {
    '~core': new URL('./src', import.meta.url).pathname
  },
  // Заголовок/иконка — заглушка каркаса; реальные — с экранами.
  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'Опрос'
    }
  }
})
