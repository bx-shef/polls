<template>
  <NuxtPage />
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
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a;
    --fg: #eceff3;
    --muted: #9aa1ab;
    --line: #2c2f34;
    --ok: #4ec27f;
    --bad: #e57368;
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
