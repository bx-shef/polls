import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAQ, FAQ_INTRO } from '../../shared/faq'
import handler from '../../server/routes/llms.txt'

/**
 * `/llms.txt` отдаётся маршрутом, и маршрут этот обязан существовать и отвечать текстом.
 *
 * ⚠ Юнит-теста собирателя текста НЕДОСТАТОЧНО, и это оплачено соседним проектом: там `llms.txt`
 * собирался отдельным шагом сборки, шаг однажды выпал — набор остался зелёным, а на сайте был 404,
 * по которому помощник клиента отвечал своими догадками. Здесь проверяется сам маршрут — и то,
 * что он лежит по адресу `/llms.txt`: у Nitro адрес маршрута и есть имя файла.
 */

/** Событие h3 в объёме, который читает маршрут: ему нужен только заголовок ответа. */
function fakeEvent() {
  const headers: Record<string, string> = {}
  return {
    event: { node: { res: { setHeader: (name: string, value: string) => void (headers[name] = value) } } },
    headers,
  }
}

const call = (event: unknown) => (handler as unknown as (event: unknown) => string)(event)

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('маршрут /llms.txt', () => {
  it('маршрут живёт по адресу /llms.txt и отвечает на любой метод', () => {
    // ⚠ Имя файла — это адрес. Переименовав файл и поправив импорт выше, мы получили бы зелёный
    // тест и 404 на сайте. А суффикс метода (`.get.ts`) отдавал `HEAD /llms.txt` в SPA — с HTML
    // вместо текста. Нашли `/review` и `/code-review` в PR #82.
    const routes = fileURLToPath(new URL('../../server/routes/', import.meta.url))
    expect(existsSync(`${routes}llms.txt.ts`)).toBe(true)
    expect(readdirSync(routes).filter(name => name.startsWith('llms.txt.'))).toEqual(['llms.txt.ts'])
  })

  it('отдаёт справку простым текстом в UTF-8', () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://polls.bx-shef.by')
    const { event, headers } = fakeEvent()

    const body = call(event)

    expect(headers['Content-Type']).toBe('text/plain; charset=utf-8')
    expect(body).toContain(FAQ_INTRO)
    expect(body).toContain(FAQ[0]!.question)
    expect(body).toContain('https://polls.bx-shef.by/help')
  })

  it('без публичного адреса не выдумывает ссылок', () => {
    vi.stubEnv('PUBLIC_BASE_URL', '')
    const { event } = fakeEvent()

    expect(call(event)).not.toContain('Справка:')
  })
})
