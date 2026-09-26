<!--
  Приманка для гварда якорей справки (`tests/unit/faq.test.ts`): ссылка стоит за атрибутом,
  внутри которого есть `>`. Регулярка первой редакции такую ссылку не находила вовсе.
  Файл не входит в приложение — он лежит вне `app/` и нигде не импортируется.
-->
<template>
  <div>
    <HelpLink
      v-if="count > 0"
      anchor="no-such-section"
    />
  </div>
</template>

<script setup lang="ts">
const count = 1
</script>
