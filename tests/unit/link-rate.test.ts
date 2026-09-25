import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIMITS, PORTAL_LIMITS, WINDOW_SECONDS } from '../../server/domain/links/rate-limit'

/**
 * Обвязка счётчика частоты над Redis (issue #17).
 *
 * ⚠ ДОМЕН РЕШАЕТ ПРАВИЛЬНО — это проверено отдельно и давно. Здесь проверяется ровно то,
 * что между доменом и Redis: как собран конвейер и какие его ответы мы считаем счётчиками.
 * Перепутанный порядок тихо снимет предел по одному из ключей — по тому самому, который
 * защищает от перебора чужих ссылок. Ни сборка, ни типы этого не покажут: индексы 0 и 2 —
 * просто числа.
 *
 * ⚠ Подделка Redis собрана ПО ФОРМЕ `ioredis`: `multi()` возвращает цепочку, `exec()` —
 * массив пар `[ошибка, значение]`. Сверено с реализацией, а не с нашим кодом: подделка,
 * согласованная с собственным вызовом, доказывает только то, что мы вызываем то, что
 * вызываем.
 */

/** Что записал конвейер и чем ответил. */
function fakeRedis(exec: unknown) {
  const calls: { command: string, args: unknown[] }[] = []
  const chain: Record<string, (...args: unknown[]) => unknown> = {}

  for (const command of ['incr', 'expire']) {
    chain[command] = (...args: unknown[]) => {
      calls.push({ command, args })
      return chain
    }
  }
  chain.exec = async () => {
    // Ошибка вместо ответа — так выглядит оборванное соединение на выполнении конвейера.
    if (exec instanceof Error) throw exec
    return exec
  }

  return { calls, client: { multi: () => chain } }
}

/**
 * Поднять модуль со свежими подделками: он читает Redis через `server/utils/redis`.
 *
 * ⚠ Журнал подделывается ЗДЕСЬ ЖЕ, а не следилкой поверх настоящего. `vi.resetModules()`
 * поднимает свежий граф модулей, и `rate.ts` получает СВОЙ экземпляр логгера — следилка,
 * поставленная на импортированный в тесте, ловила бы чужой объект и молчала. Первая
 * редакция теста так и сделала: три проверки fail-open краснели на исправном коде.
 */
async function withRedis(exec: unknown, configured = true) {
  const redis = fakeRedis(exec)
  const warnings: string[] = []

  vi.doMock('../../server/utils/redis', () => ({
    isRedisConfigured: () => configured,
    getRedis: () => {
      if (!configured) throw new Error('REDIS_URL is not set')
      return redis.client
    },
  }))
  vi.doMock('../../server/utils/logger', () => ({
    logger: {
      warn: (_fields: unknown, message: string) => void warnings.push(message),
      info: () => {},
      error: () => {},
    },
  }))
  vi.resetModules()

  const module = await import('../../server/links/rate')
  return { ...module, calls: redis.calls, warnings }
}

/** Ответ конвейера: пары «ошибка, значение» ровно в том порядке, в каком шли команды. */
const okExec = (perAddress: number, perToken: number) => [
  [null, perAddress],
  [null, 1],
  [null, perToken],
  [null, 1],
]

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../../server/utils/redis')
  vi.doUnmock('../../server/utils/logger')
  vi.resetModules()
})

describe('конвейер счётчика', () => {
  it('собирается в порядке «адрес, срок, токен, срок»', async () => {
    // ⚠ На этом порядке держатся индексы 0 и 2 в разборе ответа. Переставь команды —
    // и счётчик по адресу начнёт читаться из ответа `EXPIRE`, то есть из единицы.
    // Предел не сработает никогда, а выглядеть будет как работающий.
    const { countAndDecide, calls } = await withRedis(okExec(1, 1))

    await countAndDecide('203.0.113.7', 'хеш-токена')

    expect(calls.map(call => call.command)).toEqual(['incr', 'expire', 'incr', 'expire'])
  })

  it('срок ставится ТОЛЬКО когда его ещё нет', async () => {
    // ⚠ Без `NX` окно продлевалось бы на каждом обращении, и счётчик активного перебора
    // не сбрасывался бы никогда: предел превратился бы в пожизненную блокировку человека,
    // который просто дважды открыл анкету.
    const { countAndDecide, calls } = await withRedis(okExec(1, 1))

    await countAndDecide('203.0.113.7', 'хеш-токена')

    for (const call of calls.filter(entry => entry.command === 'expire')) {
      expect(call.args[1]).toBe(WINDOW_SECONDS)
      expect(call.args[2]).toBe('NX')
    }
  })

  it('адрес уходит в ключ ХЕШЕМ, а не как есть', async () => {
    // ⚠ Инвариант проекта: в наших хранилищах не лежат идентификаторы людей. IP-адрес
    // респондента — такой же идентификатор, и Redis переживёт инцидент так же, как журнал.
    const { countAndDecide, calls } = await withRedis(okExec(1, 1))

    await countAndDecide('203.0.113.7', 'хеш-токена')

    expect(JSON.stringify(calls)).not.toContain('203.0.113.7')
  })
})

describe('разбор ответа конвейера', () => {
  it('ГЛАВНОЕ: счётчики берутся из `INCR`, а не из `EXPIRE`', async () => {
    // Ответ собран так, что подмена видна: по адресу насчитано больше предела,
    // а `EXPIRE` отвечает единицей. Возьми мы не тот индекс — предел молчал бы.
    const { countAndDecide } = await withRedis(okExec(LIMITS.perAddress + 1, 1))

    expect(await countAndDecide('203.0.113.7', 'хеш-токена')).toMatchObject({ allow: false })
  })

  it('предел по токену читается своим индексом', async () => {
    // Второй ключ — тот, что защищает от перебора ЧУЖОЙ ссылки. Перепутанные индексы
    // сняли бы именно его, и заметить это можно было бы только перебором.
    const { countAndDecide } = await withRedis(okExec(1, LIMITS.perToken + 1))

    expect(await countAndDecide('203.0.113.7', 'хеш-токена')).toMatchObject({ allow: false })
  })

  it('под пределом пускает', async () => {
    const { countAndDecide } = await withRedis(okExec(1, 1))

    expect(await countAndDecide('203.0.113.7', 'хеш-токена')).toEqual({ allow: true })
  })

  it('ошибку внутри конвейера не считает счётчиком', async () => {
    // ⚠ `ioredis` отдаёт ошибку команды первым элементом пары, а не бросает. Прочитав
    // значение рядом с ошибкой, мы посчитали бы мусор за число обращений.
    const { countAndDecide } = await withRedis([
      [new Error('OOM'), null],
      [null, 1],
      [null, LIMITS.perToken + 1],
      [null, 1],
    ])

    // По токену предел всё равно сработал: одна испорченная команда не снимает вторую.
    expect(await countAndDecide('203.0.113.7', 'хеш-токена')).toMatchObject({ allow: false })
  })
})

describe('когда считать нечем — пускаем, но говорим об этом', () => {
  /**
   * ⚠ Все три ветки fail-open обязаны оставлять след. Ограничение частоты защищает
   * от перебора, а не от катастрофы: отказывать посетителям анкеты из-за НАШЕЙ аварии
   * значит превратить свою поломку в недоступность клиентского опроса. Но снятое
   * ограничение, о котором никто не узнал, — это дыра, открытая беззвучно. Панель ревью
   * PR #15 нашла ровно это: комментарий обещал журнал, а журнала не было.
   */
  async function warnsOn(exec: unknown, configured = true) {
    const { countAndDecide, warnings } = await withRedis(exec, configured)

    const decision = await countAndDecide('203.0.113.7', 'хеш-токена')

    return { decision, said: warnings.some(message => message.includes('ограничение частоты не сработало')) }
  }

  it('redis не настроен', async () => {
    const { decision, said } = await warnsOn(okExec(1, 1), false)

    expect(decision).toEqual({ allow: true })
    expect(said).toBe(true)
  })

  it('конвейер не выполнился целиком', async () => {
    // `exec` отдаёт `null`, когда транзакция не прошла. Считать это нулями значило бы
    // тихо снять ограничение.
    const { decision, said } = await warnsOn(null)

    expect(decision).toEqual({ allow: true })
    expect(said).toBe(true)
  })

  it('redis отказал', async () => {
    // Подделка бросает на `multi()` — так выглядит оборванное соединение.
    const { decision, said } = await warnsOn(new Error('ECONNREFUSED'))

    expect(decision).toEqual({ allow: true })
    expect(said).toBe(true)
  })
})

describe('портальные экраны считаются отдельно', () => {
  it('свои пределы, а не пределы анкеты', async () => {
    // ⚠ У публичной анкеты предел вдвое ниже. Общий ключ означал бы, что офисный трафик
    // сотрудников выедает бюджет респондента с того же адреса — или наоборот.
    const { countAndDecidePortal } = await withRedis(okExec(LIMITS.perAddress + 1, 1))

    // Для анкеты это уже перебор, для портального экрана — ещё нет.
    expect(LIMITS.perAddress).toBeLessThan(PORTAL_LIMITS.perAddress)
    expect(await countAndDecidePortal('203.0.113.7', 'член-портала')).toEqual({ allow: true })
  })

  it('и своё пространство ключей', async () => {
    const { countAndDecidePortal, calls } = await withRedis(okExec(1, 1))

    await countAndDecidePortal('203.0.113.7', 'член-портала')

    expect(String(calls[0]!.args[0])).toContain('portal')
  })
})
