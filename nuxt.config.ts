import { fileURLToPath } from 'node:url'

// Каркас Nuxt 4 для контура A (фаза связки). Ядро (движок/store/api) остаётся в `src/`
// и НЕ сканируется Nuxt: srcDir = `app/`. Серверный слой (Nitro-привязка `createApi`)
// придёт следующим слайсом в КОРНЕВОМ `server/` — в Nuxt 4 serverDir по умолчанию
// `<rootDir>/server` (не srcDir), так что доп. конфиг не нужен. Ядровой node-адаптер
// `src/server/node.ts` к Nitro отношения не имеет. `pnpm check` независим.
//
// b24ui подключается модулем `@bitrix24/b24ui-nuxt` (Tailwind + air-токены внутри модуля).
// Доступ к ядру — алиас `~core` на `src/` (без дублирования логики). ГРАНИЦА: из клиентских
// .vue/composables импортируем ТОЛЬКО `~core/client` и `~core/domain` (чистая логика без
// секретов); `~core/bitrix24|store|api|obs` — server-only (Nitro-роуты), иначе крипто/токены/
// SQL утекут в клиентский бандл. См. CLAUDE.md → «Приложение (app/)».
export default defineNuxtConfig({
  compatibilityDate: '2026-06-19',
  srcDir: 'app/',
  // color-mode ДО b24ui: чтобы b24ui при init видел модуль (hasNuxtModule) и подключил
  // свои color-mode-компоненты (для будущего тоггла темы).
  modules: ['@nuxtjs/color-mode', '@bitrix24/b24ui-nuxt'],
  // CSS-вход b24ui (Tailwind v4 + тема/токены) — обязателен, иначе компоненты без стилей.
  css: ['~/assets/css/main.css'],
  // Тёмная тема b24ui — классовая (`.dark` на <html>). color-mode по системе (prefers-color-scheme),
  // classSuffix:'' → класс ровно `dark` (как ждёт b24ui). Гейт детерминированно гоняет обе темы
  // через colorScheme-проекты. Инлайн-скрипт color-mode ставит класс до paint — без вспышки.
  colorMode: { preference: 'system', fallback: 'light', classSuffix: '' },
  // Контур A — публичный опрос (лендинг-подобный), SSR оправдан (быстрый first paint).
  ssr: true,
  devtools: { enabled: false },
  alias: {
    // fileURLToPath (не .pathname) — кроссплатформенно (на Windows .pathname даёт /C:/…).
    '~core': fileURLToPath(new URL('./src', import.meta.url))
  },
  // Заголовок/иконка — заглушка каркаса; реальные — с экранами.
  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'Опрос'
    }
  }
})
