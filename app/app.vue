<script setup lang="ts">
/**
 * The application root. Nothing but the layout switch and the global palette.
 *
 * ⚠ SEO-меты здесь нет и быть не должно. Корень применяется ко ВСЕМ страницам, включая
 * служебные и публичную анкету; мета, поставленная отсюда, уносила бы в выдачу заголовок
 * и описание лендинга с каждой из них. У соседа это подтвердилось на живом проде. Мета живёт
 * на самих страницах, служебные закрыты заголовком `X-Robots-Tag`.
 */
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>

<style>
/* Обе темы обязательны с самого начала: тёмная, добавленная потом, всегда добавляется наполовину. */
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #17181a;
  --muted: #6b7280;
  --line: #e5e7eb;
  --ok: #1f9254;
  --bad: #c0392b;
  /* Добавлено лендингом: подложка для нумерации и значков, цвет ссылки. Роли, а не значения —
     правило проекта. Лендинг сначала завёл собственный набор из восемнадцати литералов,
     и он уже разъехался с этим (`#e6e6e6` против `--fg: #eceff3`). Нашла панель ревью PR #28. */
  --surface: #eef2f7;
  --accent: #1f6feb;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a;
    --fg: #eceff3;
    --muted: #9aa1ab;
    --line: #2c2f34;
    --ok: #4ec27f;
    --bad: #e57368;
    --surface: #24272c;
    --accent: #6cb0ff;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
</style>
