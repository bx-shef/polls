<script setup lang="ts">
// Нарушение намеренное: импорт серверного модуля через псевдоним корня.
import { getDb } from '~~/server/db/client'

const db = getDb()
</script>

<template>
  <pre>{{ db }}</pre>
</template>
