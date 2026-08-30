import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import IndexPage from '../../app/pages/index.vue'

/**
 * Проверяем не столько заглушку, сколько то, что второй проект vitest живой:
 * компонент монтируется в окружении Nuxt и видит подменённый эндпоинт.
 */
registerEndpoint('/api/health', () => ({
  status: 'degraded',
  version: 'test',
  checks: {
    db: { status: 'ok', latencyMs: 3 },
    redis: { status: 'down', latencyMs: 2000, error: 'probe timed out' },
  },
}))

describe('страница-заглушка каркаса', () => {
  it('показывает состояние и переводит статусы зависимостей', async () => {
    const page = await mountSuspended(IndexPage)
    const text = page.text()

    expect(text).toContain('degraded')
    expect(text).toContain('db — отвечает')
    expect(text).toContain('redis — не отвечает')
  })

  // Задержку выводит вложенный <template v-if>, и автоформатирование разносит его
  // по строкам. Vue схлопывает такие переносы, но проверяем это явно: молча
  // разъехавшаяся вёрстка — ровно то, что линтер-форматировщик умеет ломать.
  it('выводит задержку без лишних пробелов', async () => {
    const page = await mountSuspended(IndexPage)

    expect(page.text()).toContain('(3 мс)')
  })
})
