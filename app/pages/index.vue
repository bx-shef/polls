<script setup lang="ts">
/**
 * Заглушка каркаса: показывает, что приложение поднялось и что оно думает о базе и Redis.
 * Нужна ровно до задачи 4 — дальше здесь живёт список опросов внутри портала.
 */
interface Check { status: 'ok' | 'down' | 'off', latencyMs?: number, error?: string }

const { data: health, error } = await useFetch<{
  status: string
  version: string
  checks: Record<string, Check>
}>('/api/health')

useHead({ title: 'Опросы клиентов' })

const label: Record<Check['status'], string> = {
  ok: 'отвечает',
  down: 'не отвечает',
  off: 'не настроен',
}
</script>

<template>
  <main>
    <h1>Опросы клиентов</h1>
    <p class="muted">
      Каркас поднят. Логики опросов пока нет — план работ в <code>DAY-ONE.md</code>.
    </p>

    <template v-if="health">
      <p>
        Состояние: <strong :class="health.status === 'ok' ? 'ok' : 'bad'">{{ health.status }}</strong>,
        сборка <code>{{ health.version }}</code>
      </p>
      <ul>
        <li
          v-for="(check, name) in health.checks"
          :key="name"
        >
          {{ name }} — <span :class="check.status === 'down' ? 'bad' : ''">{{ label[check.status] }}</span>
          <template v-if="check.latencyMs !== undefined">
            ({{ check.latencyMs }} мс)
          </template>
        </li>
      </ul>
    </template>
    <p
      v-else-if="error"
      class="bad"
    >
      Проверка состояния недоступна.
    </p>
  </main>
</template>

<style scoped>
main {
  max-width: 34rem;
  margin: 0 auto;
  padding: 3rem 1.25rem;
}

h1 {
  font-size: 1.5rem;
  margin: 0 0 0.5rem;
}

ul {
  padding-left: 1.1rem;
  border-top: 1px solid var(--line);
  padding-top: 0.75rem;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}

.muted { color: var(--muted); }
.ok { color: var(--ok); }
.bad { color: var(--bad); }
</style>
