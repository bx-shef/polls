import { describe, expect, it } from 'vitest'
import { createKeySerializer } from '../src/api/serial-by-key'

/**
 * Сериализация по ключу — то самое место, где закрывается промежуток между «поискал дело» и «создал
 * дело» (#138). Проверяется поведением под конкуренцией, а не формой кода: тест, который просто
 * вызывает `run` дважды подряд, прошёл бы и на пустой заглушке.
 */

/** Промис, который резолвится по команде — иначе «одновременность» в тесте не изобразить. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('createKeySerializer', () => {
  it('две работы с ОДНИМ ключом не идут внахлёст', async () => {
    // Ровно тот случай: два события одного перехода. Без очереди оба оказались бы внутри
    // «поиск → создание» одновременно и создали бы по делу.
    const s = createKeySerializer()
    const first = deferred()
    const inside: string[] = []

    const a = s.run('переход-1', async () => { inside.push('a:старт'); await first.promise; inside.push('a:финиш') })
    const b = s.run('переход-1', async () => { inside.push('b:старт') })

    await new Promise((r) => setImmediate(r))
    expect(inside, 'вторая работа влезла до конца первой').toEqual(['a:старт'])
    first.resolve()
    await Promise.all([a, b])
    expect(inside).toEqual(['a:старт', 'a:финиш', 'b:старт'])
  })

  it('РАЗНЫЕ ключи идут параллельно', async () => {
    // Иначе гроздь по одной сделке тормозила бы приглашения по всем остальным.
    const s = createKeySerializer()
    const hold = deferred()
    const done: string[] = []
    const slow = s.run('переход-1', async () => { await hold.promise; done.push('медленный') })
    await s.run('переход-2', async () => { done.push('быстрый') })
    expect(done, 'чужой ключ ждал освобождения первого').toEqual(['быстрый'])
    hold.resolve()
    await slow
  })

  it('отказ одной работы НЕ рвёт очередь по ключу', async () => {
    // Портал ответил ошибкой на поиск дел — следующее событие обязано попробовать снова, а не
    // остаться навсегда в очереди за упавшим.
    const s = createKeySerializer()
    const failed = s.run('переход-1', () => Promise.reject(new Error('портал недоступен')))
    await expect(failed).rejects.toThrow('портал недоступен')
    await expect(s.run('переход-1', () => Promise.resolve('прошло'))).resolves.toBe('прошло')
  })

  it('отказ доезжает до вызывающего, а не глотается', async () => {
    const s = createKeySerializer()
    await expect(s.run('k', () => Promise.reject(new Error('наружу')))).rejects.toThrow('наружу')
  })

  it('ключи не накапливаются: очередь опустела — ключ забыт', async () => {
    // Ключей столько же, сколько переходов за всё время жизни процесса, — без уборки это утечка.
    const s = createKeySerializer()
    await Promise.all(['a', 'b', 'c'].map((k) => s.run(k, () => Promise.resolve())))
    await new Promise((r) => setImmediate(r))
    expect(s.size(), 'ключи остались висеть после завершения работ').toBe(0)
  })

  it('уборка ключа не открывает дверь третьей работе', async () => {
    // ⚠️ Тонкое место. Когда первая работа завершилась, за ключом уже может стоять вторая — и уборка
    // обязана это увидеть. Иначе ключ удаляется, третья работа не находит очереди и стартует ВНАХЛЁСТ
    // со второй: ровно та одновременность, ради устранения которой всё и написано, только отложенная
    // на одну работу. Обычный тест «две работы по очереди» этого не ловит.
    const s = createKeySerializer()
    const holdA = deferred()
    const holdB = deferred()
    const order: string[] = []

    const a = s.run('переход-1', async () => { order.push('a:старт'); await holdA.promise })
    const b = s.run('переход-1', async () => { order.push('b:старт'); await holdB.promise })

    holdA.resolve()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(order, 'вторая работа не стартовала — тест ничего не проверяет').toContain('b:старт')

    const c = s.run('переход-1', async () => { order.push('c:старт') })
    await new Promise((r) => setImmediate(r))
    expect(order, 'третья работа влезла, пока вторая ещё держит ключ').not.toContain('c:старт')

    holdB.resolve()
    await Promise.all([a, b, c])
    expect(order).toEqual(['a:старт', 'b:старт', 'c:старт'])
  })

  it('под очередью из многих работ ключ живёт до последней', async () => {
    const s = createKeySerializer()
    const hold = deferred()
    const all = [1, 2, 3].map((i) => s.run('переход-1', async () => { if (i === 1) await hold.promise; return i }))
    expect(s.size()).toBe(1)
    hold.resolve()
    expect(await Promise.all(all)).toEqual([1, 2, 3])
    await new Promise((r) => setImmediate(r))
    expect(s.size()).toBe(0)
  })
})
