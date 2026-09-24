import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../server/utils/logger'

/**
 * Инвариант из `CLAUDE.md`: в логи не попадают токены, тексты ответов и идентификаторы
 * клиентов портала. Проверяем не список путей, а то, что реально уходит в поток:
 * список можно расширить и при этом сломать конфигурацию redaction.
 */
/**
 * ⚠ УРОВЕНЬ ПРИБИТ, и это не гигиена, а сам смысл файла. `createLogger` берёт уровень
 * из `LOG_LEVEL` окружения, а почти все проверки ниже — отрицательные: «в строке нет
 * секрета». При `LOG_LEVEL=warn` вызов `info` не пишет НИЧЕГО, строка остаётся пустой —
 * и отрицательные проверки проходят, ничего не проверив. То есть в один прекрасный день
 * у разработчика с тихим логом гвардов на утечку токенов просто нет, а гейт зелёный.
 *
 * Поймано ровно так: `pnpm check` запустили с рабочим `.env`, где `LOG_LEVEL=warn`,
 * и красными стали три ПОЛОЖИТЕЛЬНЫЕ проверки. Три отрицательные при этом молчали.
 */
beforeEach(() => {
  vi.stubEnv('LOG_LEVEL', 'info')
  return () => vi.unstubAllEnvs()
})

function captureLine(payload: Record<string, unknown>): string {
  let line = ''
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      line += String(chunk)
      callback()
    },
  })
  createLogger(sink).info(payload, 'проверка')

  // Вторая половина той же защиты: пустая строка означает, что писать было нечего,
  // а не что секрет вырезан. Отличить одно от другого потом уже нельзя.
  expect(line, 'логгер не написал ни байта — проверка ниже ничего не значит').not.toBe('')

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

  it('вырезает токен приложения в обоих написаниях', () => {
    // `CASE_VARIANTS` меняет регистр, но не snake↔camel. Приём установки завёл поле
    // `applicationToken`, и без отдельной строки в списке оно уехало бы в лог целиком.
    const line = captureLine({ application_token: 'СЕКРЕТ', grant: { applicationToken: 'СЕКРЕТ' } })

    expect(line).not.toContain('СЕКРЕТ')
  })

  it('вырезает текст ответа клиента', () => {
    const line = captureLine({ response: { answers: ['всё плохо'], payload: { text: 'всё плохо' } } })

    expect(line).not.toContain('всё плохо')
  })

  // Гвард: поля CRM Битрикс24 приходят ЗАГЛАВНЫМИ, а `fast-redact` сравнивает имена
  // буквально. Список из одних строчных пропускал сырой REST-ответ целиком.
  it('вырезает поля Битрикс24 в их родном написании', () => {
    const line = captureLine({
      result: {
        ID: '42',
        NAME: 'СЕКРЕТ',
        LAST_NAME: 'СЕКРЕТ',
        EMAIL: [{ VALUE: 'СЕКРЕТ' }],
        PHONE: [{ VALUE: 'СЕКРЕТ' }],
      },
    })

    expect(line).not.toContain('СЕКРЕТ')
    // идентификатор элемента — не персональные данные, по нему и ищут в портале
    expect(line).toContain('42')
  })

  it('оставляет то, ради чего лог и пишется', () => {
    const line = captureLine({ portalId: 'p-1', kind: 'timeline.comment', attempts: 2 })

    expect(line).toContain('timeline.comment')
    expect(line).toContain('p-1')
  })
})
