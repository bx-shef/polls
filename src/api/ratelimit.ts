/**
 * Rate-limit «скользящее окно» (анти-абьюз, ISSUE #4): не больше `limit`
 * событий на ключ (обычно IP) за `windowMs`. In-memory — для одного инстанса;
 * горизонтальное масштабирование вынесет лимитер в общий стор (фаза деплоя).
 */
export interface RateLimiter {
  /** true — событие допущено (и учтено); false — лимит исчерпан. */
  allow(key: string, now: Date): boolean
}

export interface SlidingWindowOptions {
  limit: number
  windowMs: number
  /**
   * Потолок числа ключей (защита памяти от флуда уникальными IP; default 50 000).
   * При переполнении протухшие ключи вычищаются; если место не освободилось —
   * НОВЫЕ ключи получают отказ (fail-closed: анти-абьюз важнее доступности).
   */
  maxKeys?: number
}

export class SlidingWindowLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly maxKeys: number

  constructor(private readonly opts: SlidingWindowOptions) {
    this.maxKeys = opts.maxKeys ?? 50_000
  }

  allow(key: string, now: Date): boolean {
    const t = now.getTime()
    const from = t - this.opts.windowMs
    const prev = this.hits.get(key)
    const recent = prev ? prev.filter((x) => x > from) : []
    if (recent.length >= this.opts.limit) {
      this.hits.set(key, recent)
      return false
    }
    if (prev == null && this.hits.size >= this.maxKeys) {
      this.sweep(from)
      if (this.hits.size >= this.maxKeys) return false
    }
    recent.push(t)
    this.hits.set(key, recent)
    return true
  }

  /** Удаляет ключи, у которых не осталось событий в окне (вызов — при переполнении). */
  private sweep(from: number): void {
    for (const [k, arr] of this.hits) {
      if (!arr.some((x) => x > from)) this.hits.delete(k)
    }
  }
}
