<script setup lang="ts">
// Корневой компонент. B24App — обязательная обёртка b24ui (провайдер темы/тостов/оверлеев).
// Страницы рендерятся через NuxtPage (роутинг по app/pages/).
// Тоггл темы (#45) — нативный `B24ColorModeButton` (b24ui), согласован с `@nuxtjs/color-mode`
// (storageKey тот же): иконка солнце/луна по классу `.dark`, клик флипает preference light↔dark.
// Глобально (fixed) — доступен и в контуре A (опрос), и в контуре B (дашборд).
</script>

<template>
  <B24App>
    <B24ColorModeButton class="fixed right-4 top-4 z-50" />
    <NuxtPage />
  </B24App>
</template>
