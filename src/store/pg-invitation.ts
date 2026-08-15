import { createHash, randomUUID } from 'node:crypto'
import type { CrmContext, Invitation } from '../domain/schema'
import type {
  InvitationCreate, InvitationConsume, InvitationPin, InvitationStore
} from '../api/invitation'
import type { Queryable } from './types'

/**
 * Приглашения в PostgreSQL (#4) — вторая реализация порта `InvitationStore`.
 *
 * **Зачем.** In-memory стор терял все живые токены на каждом перезапуске, а перезапуск идёт на
 * каждом мерже (автодеплой). Пока страница опроса токен не читала, это было незаметно; как только
 * прочитала — свежая ссылка стала показывать «срок истёк» просто потому, что вышел релиз. Отсюда же
 * зависимость #138 (дедуп приглашений) и #126 (доставка): и то и другое опирается на то, что
 * приглашение живёт дольше процесса.
 *
 * **Токен хранится ХЕШЕМ** (SHA-256). Угроза — дамп/чтение базы: из него не должны доставаться
 * рабочие ссылки. HMAC с секретом здесь ничего не добавил бы: токен — `randomUUID`, то есть 122 бита
 * энтропии, словарной атаки на него не существует, а ключ пришлось бы хранить и ротировать.
 * (Для сравнения: `portalHash` в телеметрии солится именно потому, что там хешируется ДОМЕН — малый
 * предсказуемый словарь.)
 *
 * ⚠️ Возражение «но `response.invitation_token` хранит токен ОТКРЫТЫМ, значит хеш бесполезен» разбито
 * тем, КОГДА появляется та строка: ответ пишется только на успешном `submit`, то есть токен к этому
 * моменту уже израсходован и ссылка мертва. В дампе открытыми лежат ровно погашенные токены, а все
 * живые — только хешами. Открытая колонка там нужна для durable-дедупа (`uq_response_invitation_token`),
 * и заменить её на хеш можно будет заодно с переходом дедупа на FK `invitation_id` (#4).
 *
 * ⚠️ **Открытый токен существует ровно один раз** — в ответе `create`. `peek`/`consume` возвращают
 * тот токен, который пришёл АРГУМЕНТОМ, а не содержимое хранилища: в хранилище его нет.
 *
 * ⚠️ **`portalId` задаётся конструктором**, как у `PgStore`, а не приходит параметром порта. Это не
 * стиль: `context` приглашения несёт те же персональные данные, что и ответ, и реализация без
 * `portal_id` молча выпала бы и из удаления данных портала, и из редакции ПДн (#31).
 */
export interface PgInvitationStoreOptions {
  portalId: number
  /** Окно ответа по умолчанию, если приглашение выписано без своего TTL (30 дней). */
  ttlMs?: number
  idGen?: () => string
}

/** Хеш токена. Экспортирован ради тестов и чистки — правило хеширования одно на всех. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Сколько дней держать МЁРТВОЕ приглашение (израсходованное или протухшее) до удаления.
 *
 * Дефолт 30 суток — не про работу приглашения, а про разбор жалоб: «мне пришла ссылка, а она не
 * открылась» разбирается по строке, которой уже нет смысла жить дальше. Клэмп [1, 365] и деградация
 * мусора в дефолт — по образцу {@link resolveTombstoneDays}: занижение до нуля снесло бы приглашение
 * ровно в момент истечения (а вместе с ним и возможность отличить «протухла» от «не было такой»), а
 * завышение на годы вернуло бы вечное накопление ПДн, ради устранения которого чистка и заведена.
 */
export const DEFAULT_INVITATION_KEEP_DAYS = 30
export const MIN_INVITATION_KEEP_DAYS = 1
export const MAX_INVITATION_KEEP_DAYS = 365
export function resolveInvitationKeepDays(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INVITATION_KEEP_DAYS
  return Math.min(MAX_INVITATION_KEEP_DAYS, Math.max(MIN_INVITATION_KEEP_DAYS, Math.trunc(n)))
}

interface InvitationRow {
  survey_key: string | null
  version_no: number | null
  context: CrmContext | null
  sent_at: Date
  expires_at: Date | null
}

export class PgInvitationStore implements InvitationStore {
  private readonly ttlMs: number
  private readonly idGen: () => string

  constructor(
    private readonly db: Queryable,
    private readonly opts: PgInvitationStoreOptions
  ) {
    this.ttlMs = opts.ttlMs ?? 30 * 24 * 60 * 60_000
    this.idGen = opts.idGen ?? randomUUID
  }

  async create(input: InvitationCreate, now: Date): Promise<Invitation> {
    // Явный токен — только у демо-засева (см. `InvitationCreate.token`); боевым генерируем. Порт
    // обязан вести себя одинаково в обеих реализациях, иначе это не порт, а два разных стора.
    const token = input.token ?? this.idGen()
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? this.ttlMs))
    const c = input.context
    // Денормализованные колонки CRM заполняем ВМЕСТЕ с `context`: по ним построены индексы админских
    // выборок из 0001, и оставить их пустыми значило бы завести данные, невидимые для этих выборок.
    // ⚠️ `deal_title` из 0001 НЕ заполняем: в `CrmContext` такого поля нет вовсе (есть `companyName`/
    // `dealCategoryName`/`responsibleName`, и они лежат в `context`). Колонка осталась от первой
    // схемы, у которой не было ни одного писателя; заводить под неё поле в контексте ради заполнения
    // колонки — это хвост, виляющий собакой.
    await this.db.query(
      `insert into invitation
         (portal_id, token_hash, survey_key, version_no, status, sent_at, expires_at,
          deal_id, deal_category_id, deal_stage_id, company_id, contact_id, responsible_id,
          deal_amount, context)
       values ($1, $2, $3, $4, 'sent', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        this.opts.portalId, hashToken(token), input.surveyKey, input.versionNo, now, expiresAt,
        c.dealId ?? null, c.dealCategoryId ?? null, c.dealStageId ?? null, c.companyId ?? null,
        c.contactId ?? null, c.responsibleId ?? null, c.dealAmount ?? null,
        JSON.stringify(c)
      ]
    )
    return {
      token,
      surveyKey: input.surveyKey,
      versionNo: input.versionNo,
      context: input.context,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    }
  }

  async peek(token: string, now: Date): Promise<Invitation | undefined> {
    const r = await this.db.query<InvitationRow>(
      `select survey_key, version_no, context, sent_at, expires_at
         from invitation
        where portal_id = $1 and token_hash = $2 and used_at is null and expires_at > $3`,
      [this.opts.portalId, hashToken(token), now]
    )
    const row = r.rows[0]
    return row ? this.toInvitation(token, row, 'pending') : undefined
  }

  async consume(token: string, pin: InvitationPin, now: Date): Promise<InvitationConsume> {
    const hash = hashToken(token)
    // ⚠️ ОДИН запрос, а не «прочитать → проверить → пометить». Одноразовость держится на условии
    // `used_at is null` внутри UPDATE: две одновременные отправки по одной ссылке борются за одну
    // строку, и вторая получит ноль строк. В in-memory это давалось однопоточностью Node даром,
    // здесь — нет, и check-then-act пропустил бы обе.
    const upd = await this.db.query<InvitationRow>(
      `update invitation
          set used_at = $4, status = 'completed', completed_at = $4
        where portal_id = $1 and token_hash = $2 and used_at is null and expires_at > $4
          and survey_key = $3 and version_no = $5
      returning survey_key, version_no, context, sent_at, expires_at`,
      [this.opts.portalId, hash, pin.surveyKey, now, pin.versionNo]
    )
    const row = upd.rows[0]
    if (row) return { status: 'ok', invitation: this.toInvitation(token, row, 'used') }

    // Ноль строк — разбираемся ПОЧЕМУ, отдельным чтением. Диагноз нужен только для кода ответа:
    // решение уже принято выше и от этого чтения не зависит, поэтому гонка здесь безопасна.
    const diag = await this.db.query<{ used: boolean; expired: boolean; survey_key: string | null; version_no: number | null }>(
      `select (used_at is not null) as used, (expires_at <= $3) as expired, survey_key, version_no
         from invitation where portal_id = $1 and token_hash = $2`,
      [this.opts.portalId, hash, now]
    )
    const d = diag.rows[0]
    if (!d || d.expired) return { status: 'unknown' }
    if (d.used) return { status: 'replay' }
    // Строка жива и не использована — значит не сошёлся пин. Токен НЕ сожжён: клиент может дослать
    // на верный опрос (анти-DoS на утёкший токен — контракт порта).
    return { status: 'mismatch' }
  }

  /**
   * Чистка по сроку — рантайм-джобой, не оператором в миграции: миграции проигрываются на КАЖДОМ
   * старте, и скан таблицы уезжал бы в boot-путь. Сносим то, что уже не может быть использовано:
   * протухшее и израсходованное старше `keepDays`. Возвращает число удалённых строк.
   *
   * ⚠️ Считаем по `rows.length` от `RETURNING`, а не по `rowCount`: контракт `Queryable` минимален и
   * `rowCount` в нём не объявлен (тот же приём, что в `sweepTombstones`).
   */
  async sweepExpired(now: Date, keepDays: number): Promise<number> {
    const days = Number.isFinite(keepDays) ? Math.min(365, Math.max(1, Math.trunc(keepDays))) : 30
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60_000)
    const r = await this.db.query<{ id: number }>(
      `delete from invitation
        where portal_id = $1
          and ((used_at is not null and used_at < $2) or (expires_at is not null and expires_at < $2))
      returning id`,
      [this.opts.portalId, cutoff]
    )
    return r.rows.length
  }

  private toInvitation(token: string, row: InvitationRow, status: 'pending' | 'used'): Invitation {
    return {
      token,
      surveyKey: row.survey_key ?? '',
      versionNo: row.version_no ?? 0,
      context: row.context ?? {},
      status,
      createdAt: new Date(row.sent_at).toISOString(),
      ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {})
    }
  }
}
