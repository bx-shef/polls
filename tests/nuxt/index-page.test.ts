import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
// h3 закреплён в devDependencies версией, которую использует Nuxt: тянуть его как
// транзитивную зависимость — значит однажды получить чужой мажор в тесте.
import { defineEventHandler, setResponseStatus } from 'h3'
import { describe, expect, it } from 'vitest'
import IndexPage from '../../app/pages/index.vue'

/**
 * Гвард под найденный дефект: `/api/health` отвечает 503, когда зависимость лежит,
 * а `useFetch` без `ignoreResponseError` отбрасывает тело такого ответа. Панель
 * зависимостей пустела ровно в тот момент, когда она единственное, что нужно.
 * Поэтому эндпоинт здесь отдаёт настоящий 503, а не 200 с телом «degraded».
 */
registerEndpoint('/api/health', defineEventHandler((event) => {
  setResponseStatus(event, 503)
  return {
    status: 'degraded',
    version: 'test',
    checks: {
      db: { status: 'ok', latencyMs: 3 },
      redis: { status: 'down', latencyMs: 4000 },
      queue: { status: 'off' },
    },
  }
}))

/**
 * Проверяем не столько заглушку, сколько то, что второй проект vitest живой:
 * компонент монтируется в окружении Nuxt и видит подменённый эндпоинт.
 */
describe('страница-заглушка каркаса', () => {
  it('показывает состояние и переводит статусы зависимостей', async () => {
    const page = await mountSuspended(IndexPage)
    const text = page.text()

    expect(text).toContain('degraded')
    expect(text).toContain('db — отвечает')
    expect(text).toContain('redis — не отвечает')
    expect(text).toContain('queue — не настроен')
  })

  // Задержку выводит вложенный <template v-if>, и автоформатирование разносит его
  // по строкам. Vue схлопывает такие переносы, но проверяем это явно: молча
  // разъехавшаяся вёрстка — ровно то, что линтер-форматировщик умеет ломать.
  it('выводит задержку без лишних пробелов', async () => {
    const page = await mountSuspended(IndexPage)

    expect(page.text()).toContain('(3 мс)')
  })
})
