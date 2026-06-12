import { randomUUID } from 'node:crypto'

/**
 * Серверный nonce (анти-replay, ISSUE #4): GET /api/session выдаёт одноразовый
 * токен с TTL, POST /api/submit его «сжигает». Повтор → 'replay' (HTTP 409),
 * неизвестный/протухший → 'unknown' (HTTP 403).
 */
export interface NonceStore {
  /** Выдаёт nonce или null при переполнении (защита памяти от флуда /session). */
  issue(now: Date): string | null
  consume(nonce: string, now: Date): 'ok' | 'replay' | 'unknown'
}

export interface MemoryNonceStoreOptions {
  /** Время жизни nonce (по умолчанию 15 минут — см. ISSUE #4). */
  ttlMs?: number
  /** Максимум невостребованных nonce (по умолчанию 10 000). */
  maxPending?: number
  idGen?: () => string
}

/**
 * In-memory реализация: достаточно для одного инстанса (MVP). Горизонтальное
 * масштабирование потребует общего стора (Redis/Postgres) — фаза деплоя, #4.
 * Очистка протухших — на каждом обращении (без таймеров: детерминизм в тестах).
 */
export class MemoryNonceStore implements NonceStore {
  private readonly pending = new Map<string, number>() // nonce → expiresAt (ms)
  private readonly used = new Map<string, number>() // различаем replay от unknown до истечения TTL
  private readonly ttlMs: number
  private readonly maxPending: number
  private readonly idGen: () => string

  constructor(opts: MemoryNonceStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000
    this.maxPending = opts.maxPending ?? 10_000
    this.idGen = opts.idGen ?? randomUUID
  }

  issue(now: Date): string | null {
    this.prune(now.getTime())
    if (this.pending.size >= this.maxPending) return null
    const nonce = this.idGen()
    this.pending.set(nonce, now.getTime() + this.ttlMs)
    return nonce
  }

  consume(nonce: string, now: Date): 'ok' | 'replay' | 'unknown' {
    const t = now.getTime()
    this.prune(t)
    if (this.used.has(nonce)) return 'replay'
    const expiresAt = this.pending.get(nonce)
    if (expiresAt == null || expiresAt <= t) return 'unknown'
    this.pending.delete(nonce)
    this.used.set(nonce, t + this.ttlMs)
    return 'ok'
  }

  private prune(t: number): void {
    for (const [k, exp] of this.pending) if (exp <= t) this.pending.delete(k)
    for (const [k, exp] of this.used) if (exp <= t) this.used.delete(k)
  }
}
