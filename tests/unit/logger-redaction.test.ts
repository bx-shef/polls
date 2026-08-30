import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../server/utils/logger'

/**
 * Инвариант из `CLAUDE.md`: в логи не попадают токены, тексты ответов и идентификаторы
 * клиентов портала. Проверяем не список путей, а то, что реально уходит в поток:
 * список можно расширить и при этом сломать конфигурацию redaction.
 */
function captureLine(payload: Record<string, unknown>): string {
  let line = ''
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      line += String(chunk)
      callback()
    },
  })
  createLogger(sink).info(payload, 'проверка')
  return line
}

describe('логгер прячет секреты', () => {
  it('вырезает токены портала в корне записи', () => {
    const line = captureLine({ access_token: 'СЕКРЕТ', refresh_token: 'СЕКРЕТ' })

    expect(line).not.toContain('СЕКРЕТ')
    expect(line).toContain('[скрыто]')
  })

  it('вырезает их же на двух уровнях вложенности', () => {
    const line = captureLine({ portal: { auth: 'СЕКРЕТ' }, job: { data: { token: 'СЕКРЕТ' } } })

    expect(line).not.toContain('СЕКРЕТ')
  })

  it('вырезает текст ответа клиента', () => {
    const line = captureLine({ response: { answers: ['всё плохо'], payload: { text: 'всё плохо' } } })

    expect(line).not.toContain('всё плохо')
  })

  it('оставляет то, ради чего лог и пишется', () => {
    const line = captureLine({ portalId: 'p-1', kind: 'timeline.comment', attempts: 2 })

    expect(line).toContain('timeline.comment')
    expect(line).toContain('p-1')
  })
})
