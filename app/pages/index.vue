<script setup lang="ts">
// Каркас-заглушка корневого маршрута: подтверждает, что Nuxt + b24ui рендерят страницу.
// Реальные экраны Интро/Опрос/Спасибо (на SurveyFill + b24ui) — следующая фаза (#34, контур A).
</script>

<template>
  <main class="intro">
    <div class="intro__card">
      <p class="intro__badge">Опрос · контур A</p>
      <h1 class="intro__title">Каркас Nuxt + b24ui</h1>
      <p class="intro__lead">
        Приложение поднято. Дальше — экраны опроса поверх готового ядра
        (<code>SurveyFill</code>) и Nitro-привязка к <code>createApi</code>.
      </p>
      <B24Button color="air-primary" size="lg" label="Начать" />
    </div>
  </main>
</template>

<style scoped>
/* Айдентика контура A (docs/design.md §2): индиго-акцент, тёплый off-white фон. */
.intro {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: #FBFBF9;
  color: #15161A;
}
.intro__card {
  width: 100%;
  max-width: 560px;
  background: #fff;
  border: 1px solid #E7E7E2;
  border-radius: 20px;
  padding: 40px;
  text-align: center;
}
.intro__badge {
  display: inline-block;
  font: 600 12px/1 ui-monospace, monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #5B5BD6;
  background: #EEEEFB;
  padding: 8px 12px;
  border-radius: 999px;
  margin-bottom: 24px;
}
.intro__title { font-size: 32px; line-height: 1.15; font-weight: 700; margin-bottom: 16px; }
.intro__lead { font-size: 17px; color: #6B6C72; line-height: 1.5; margin-bottom: 32px; }
</style>
