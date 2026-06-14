import { randomUUID } from 'node:crypto'
import type { CrmContext, Invitation } from '../domain/schema'

/**
 * Стор приглашений (invitation-flow #3) по образцу `MemoryNonceStore`: `create`
 * кладёт СНИМОК CRM-контекста под одноразовый токен, `consume` его расходует.
 * Single-use = идемпотентность `addResponse` по приглашению (#4). In-memory —
 * один инстанс (MVP); общий стор/таблица в `PgStore` для мульти-инстанса — фаза
 * деплоя (#4), как у nonce/rate-limit.
 */
export interface InvitationCreate {
  surveyKey: string
  versionNo: number
  context: CrmContext
  /** TTL приглашения в мс (по умолчанию — из стора). */
  ttlMs?: number
}

export type InvitationConsume =
  | { status: 'ok'; invitation: Invitation }
  | { status: 'replay' }
  | { status: 'unknown' }

export interface InvitationStore {
  /** Создаёт приглашение со снимком контекста; возвращает запись с токеном. */
  create(input: InvitationCreate, now: Date): Invitation
  /** Чтение без расходования (предпросмотр анкеты по ссылке). undefined — нет/протух. */
  peek(token: string, now: Date): Invitation | undefined
  /** Атомарно помечает использованным и возвращает приглашение (single-use). */
  consume(token: string, now: Date): InvitationConsume
}

export interface MemoryInvitationStoreOptions {
  /** Окно ответа на опрос (по умолчанию 30 дней). */
  ttlMs?: number
  /** Потолок числа приглашений в памяти (по умолчанию 100 000). */
  maxPending?: number
  idGen?: () => string
}

export class MemoryInvitationStore implements InvitationStore {
  private readonly items = new Map<string, Invitation>()
  private readonly expiry = new Map<string, number>() // token → expiresAt (ms)
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
    // потолок памяти: вытесняем самое старое (Map хранит порядок вставки)
    if (this.items.size >= this.maxPending) {
      for (const oldest of this.items.keys()) {
        this.items.delete(oldest)
        this.expiry.delete(oldest)
        break
      }
    }
    const token = this.idGen()
    const expiresAtMs = t + (input.ttlMs ?? this.ttlMs)
    const invitation: Invitation = {
      token,
      surveyKey: input.surveyKey,
      versionNo: input.versionNo,
      context: input.context,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    }
    this.items.set(token, invitation)
    this.expiry.set(token, expiresAtMs)
    return invitation
  }

  peek(token: string, now: Date): Invitation | undefined {
    this.prune(now.getTime())
    return this.items.get(token)
  }

  consume(token: string, now: Date): InvitationConsume {
    this.prune(now.getTime())
    const inv = this.items.get(token)
    if (!inv) return { status: 'unknown' }
    if (inv.status === 'used') return { status: 'replay' }
    const used: Invitation = { ...inv, status: 'used' }
    this.items.set(token, used)
    return { status: 'ok', invitation: used }
  }

  /** Чистка протухших (без таймеров — детерминизм в тестах, как у nonce). */
  private prune(t: number): void {
    for (const [token, exp] of this.expiry) {
      if (exp <= t) {
        this.expiry.delete(token)
        this.items.delete(token)
      }
    }
  }
}
