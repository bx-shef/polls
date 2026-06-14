import { randomUUID } from 'node:crypto'
import type { CrmContext, Invitation } from '../domain/schema'

/**
 * Стор приглашений (invitation-flow #3) по образцу `MemoryNonceStore`: `create`
 * кладёт СНИМОК CRM-контекста под одноразовый токен, `consume` его расходует — но
 * только при совпадении пина опроса/версии (чужой пин НЕ сжигает токен). Single-use
 * = идемпотентность `addResponse` по приглашению (#4). In-memory — один инстанс
 * (MVP); общий стор/таблица в `PgStore` для мульти-инстанса — фаза деплоя (#4),
 * как у nonce/rate-limit.
 */
export interface InvitationCreate {
  surveyKey: string
  versionNo: number
  context: CrmContext
  /** TTL приглашения в мс (по умолчанию — из стора). */
  ttlMs?: number
}

/** Пин опроса/версии, к которому привязан токен (сверяется при расходе). */
export interface InvitationPin {
  surveyKey: string
  versionNo: number
}

export type InvitationConsume =
  | { status: 'ok'; invitation: Invitation }
  | { status: 'replay' }
  | { status: 'mismatch' }
  | { status: 'unknown' }

export interface InvitationStore {
  /** Создаёт приглашение со снимком контекста; возвращает запись с токеном. */
  create(input: InvitationCreate, now: Date): Invitation
  /**
   * Чтение без расходования (предпросмотр анкеты по ссылке). Возвращает только
   * ЖИВЫЕ pending-приглашения; использованные/протухшие → `undefined` (приватность:
   * CRM-снимок израсходованного токена наружу не отдаём).
   */
  peek(token: string, now: Date): Invitation | undefined
  /**
   * Атомарно: при совпадении пина помечает использованным и возвращает приглашение
   * (single-use). `replay` — уже использован, `mismatch` — чужой опрос/версия (токен
   * НЕ сжигается, клиент может дослать на верный опрос), `unknown` — нет/протух.
   */
  consume(token: string, pin: InvitationPin, now: Date): InvitationConsume
}

export interface MemoryInvitationStoreOptions {
  /** Окно ответа на опрос (по умолчанию 30 дней). */
  ttlMs?: number
  /** Потолок числа ЖИВЫХ приглашений в памяти (по умолчанию 100 000). */
  maxPending?: number
  idGen?: () => string
}

export class MemoryInvitationStore implements InvitationStore {
  private readonly pending = new Map<string, { inv: Invitation; exp: number }>()
  // отдельный used-Map (token → expiresAt) различает replay от unknown в окне TTL
  // от момента использования — паритет с MemoryNonceStore (образец).
  private readonly used = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxPending: number
  private readonly idGen: () => string

  constructor(opts: MemoryInvitationStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 24 * 60 * 60_000
    this.maxPending = opts.maxPending ?? 100_000
    this.idGen = opts.idGen ?? randomUUID
  }

  create(input: InvitationCreate, now: Date): Invitation {
    const t = now.getTime()
    this.prune(t)
    // потолок памяти: FIFO-вытеснение самого старого по ВСТАВКЕ pending (не по сроку);
    // может убрать ещё живое приглашение, но переполнение маловероятно — приглашения
    // создаёт авторизованный binding-слой на закрытии сделок, а не пользовательский флуд.
    if (this.pending.size >= this.maxPending) {
      for (const oldest of this.pending.keys()) {
        this.pending.delete(oldest)
        break
      }
    }
    const token = this.idGen()
    const exp = t + (input.ttlMs ?? this.ttlMs)
    const invitation: Invitation = {
      token,
      surveyKey: input.surveyKey,
      versionNo: input.versionNo,
      context: input.context,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(exp).toISOString()
    }
    this.pending.set(token, { inv: invitation, exp })
    return invitation
  }

  peek(token: string, now: Date): Invitation | undefined {
    this.prune(now.getTime())
    return this.pending.get(token)?.inv
  }

  consume(token: string, pin: InvitationPin, now: Date): InvitationConsume {
    const t = now.getTime()
    this.prune(t)
    if (this.used.has(token)) return { status: 'replay' }
    const entry = this.pending.get(token)
    if (!entry) return { status: 'unknown' }
    if (entry.inv.surveyKey !== pin.surveyKey || entry.inv.versionNo !== pin.versionNo) {
      return { status: 'mismatch' } // чужой пин — токен не сжигаем
    }
    this.pending.delete(token)
    this.used.set(token, t + this.ttlMs) // свежий TTL от момента использования (как nonce)
    return { status: 'ok', invitation: { ...entry.inv, status: 'used' } }
  }

  /** Чистка протухших (без таймеров — детерминизм в тестах, как у nonce). */
  private prune(t: number): void {
    for (const [token, e] of this.pending) if (e.exp <= t) this.pending.delete(token)
    for (const [token, exp] of this.used) if (exp <= t) this.used.delete(token)
  }
}
