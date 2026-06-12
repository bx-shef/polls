/**
 * Rate-limit «скользящее окно» (анти-абьюз, ISSUE #4): не больше `limit`
 * событий на ключ (обычно IP) за `windowMs`. In-memory — для одного инстанса;
 * горизонтальное масштабирование вынесет лимитер в общий стор (фаза деплоя).
 */
export interface RateLimiter {
  /** true — событие допущено (и учтено); false — лимит исчерпан. */
  allow(key: string, now: Date): boolean
}

export class SlidingWindowLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(private readonly opts: { limit: number; windowMs: number }) {}

  allow(key: string, now: Date): boolean {
    const t = now.getTime()
    const from = t - this.opts.windowMs
    const recent = (this.hits.get(key) ?? []).filter((x) => x > from)
    if (recent.length >= this.opts.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(t)
    this.hits.set(key, recent)
    return true
  }
}
