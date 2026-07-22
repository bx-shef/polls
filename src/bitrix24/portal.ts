import type { Queryable } from '../store/types'
import { TokenCipher, encryptedBlobSchema } from './crypto'
import { Bitrix24OAuth, OAuthError, oauthTokensSchema, type OAuthTokens } from './oauth'

/**
 * Хранилище OAuth-токенов портала (ISSUE #3): пишет/читает `portal.tokens`
 * в зашифрованном виде (TokenCipher) и прозрачно обновляет протухший access-token.
 * Драйвер-агностично (`Queryable` — pg.Pool/pglite), без новой prod-зависимости.
 * tenant — `member_id` портала (Bitrix24-идентификатор).
 *
 * Устойчивость lifecycle (миграция 0004, docs/improvement-plan.md §2):
 *  - `updated_at` штампуется на install/refresh — основа keep-alive (`listNearExpiry`),
 *    иначе простаивающий портал теряет refresh_token на 180-й день;
 *  - `save` при install-событии сверяется с тумбстоуном (out-of-order install после
 *    uninstall не воскрешает удалённый портал), настоящая переустановка чистит тумбстоун;
 *  - `updateOnRefresh` — UPDATE-only: исчезла строка под конкурентным uninstall → UPDATE
 *    затрагивает 0 строк (возвращает false), портал остаётся удалён (второй, независимый
 *    от тумбстоуна гард против воскрешения);
 *  - `deletePortal` (ONAPPUNINSTALL) чистит все данные портала в транзакции.
 *
 * Известные ограничения координации (single-write DB-операции, вынесено в #4/§2.5):
 *  - `save`-гард — check-then-act (SELECT тумбстоуна → upsert) без лока: при РЕАЛЬНОЙ
 *    конкуренции install↔uninstall возможна интерлейсинг-гонка. Сейчас не эксплуатируется
 *    (events-эндпоинт не подключён, install.post.ts не шлёт eventTs);
 *  - `updateOnRefresh` — одиночный DB-write ПОСЛЕ успешного OAuth-рефреша: при сбое персиста
 *    новые токены теряются, а сервер уже мог отозвать старый refresh_token. Общий лок между
 *    инстансами (advisory-lock) закроет оба случая при scale-out.
 */

/** Запас до истечения access-token: обновляемся заранее, чтобы не отдать почти-протухший (60 с). */
const REFRESH_SKEW_MS = 60_000

/** Срок жизни refresh_token Bitrix24 (дней). Порог keep-alive считается от него. */
export const REFRESH_TTL_DAYS = 180
/** Запас keep-alive: рефрешим за N дней до истечения refresh_token (полоса у истечения). */
export const KEEPALIVE_SKEW_DAYS = 3
const DAY_MS = 86_400_000

/**
 * Авторитетный резолвер install-маппинга `domain → member_id` для handshake app-фрейма (#47/#49):
 * по уже-провалидированному (SSRF-allowlist) домену портала отдаёт его `member_id` из таблицы
 * `portal` (заполняется при OAuth-установке, `PortalTokenStore.save`). undefined — портал не
 * установлен (handshake тогда fail-closed). Драйвер-агностично (`Queryable` — pg.Pool/pglite).
 *
 * Это боевая подмена no-op-резолвера, который `verifyFrameAuth`/`createPortalAuthenticator`
 * получают инъекцией (Nitro: `setPortalResolver`). member_id берётся из БД, НЕ из недоверенного
 * POST — анти-cross-tenant (сверку с заявленным делает `verifyFrameAuth`).
 */
export async function resolveMemberIdByDomain(db: Queryable, domain: string): Promise<string | undefined> {
  const r = await db.query<{ member_id: string }>(
    'select member_id from portal where domain = $1 limit 1',
    [domain]
  )
  return r.rows[0]?.member_id
}

/** Опции сохранения токенов при установке. */
export interface SaveTokensOpts {
  /** Часы для `updated_at` (тест фиксирует). Default: `new Date()`. */
  now?: Date
  /**
   * unix-СЕКУНДЫ top-level `ts` install-события. Если задан — включается тумбстоун-гард:
   * install не старше зафиксированного uninstall не воскрешает портал. Без него (ручной
   * вызов/тест/текущий install.post.ts) гард не применяется — поведение как раньше (upsert).
   */
  eventTs?: number
}

/**
 * Опции подбора порталов у истечения refresh_token (keep-alive). Инвариант: `skewDays < ttlDays`
 * (иначе `cutoffOld` уходит в будущее и полоса теряет смысл) — дефолты его соблюдают.
 */
export interface NearExpiryOpts {
  /** Срок жизни refresh_token в днях. Default: `REFRESH_TTL_DAYS` (180). */
  ttlDays?: number
  /** За сколько дней до истечения освежать. Default: `KEEPALIVE_SKEW_DAYS` (3). */
  skewDays?: number
  /** Кап батча (bound на всплеск к OAuth-серверу). Default: 50. */
  limit?: number
}

export class PortalTokenStore {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: TokenCipher
  ) {}

  /** Шифрует токены в blob-строку для колонки `tokens` (единый формат для save/updateOnRefresh). */
  private sealBlob(tokens: OAuthTokens): string {
    return JSON.stringify(this.cipher.seal(JSON.stringify(tokens)))
  }

  /** Транзакция, если драйвер умеет; иначе — последовательные запросы (см. Queryable). */
  private inTx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction ? this.db.transaction(fn) : fn(this.db)
  }

  /**
   * Сохраняет токены портала при УСТАНОВКЕ (upsert по member_id), шифруя перед записью и
   * штампуя `updated_at`. Единый `save(tokens, opts)` вместо раздельного `saveOnInstall`
   * (отход от improvement-plan §2.2 — обратно-совместимо, не трогает существующие вызовы).
   *
   * При `opts.eventTs` — тумбстоун-гард: если зафиксирован uninstall не старше события, запись
   * пропускается (портал не воскрешается устаревшими кредами) и возвращается `false`; настоящая
   * переустановка (строго новее) чистит устаревший тумбстоун. Возвращает `true`, если запись
   * выполнена. Refresh идёт отдельным путём (`updateOnRefresh`, UPDATE-only).
   */
  async save(tokens: OAuthTokens, opts: SaveTokensOpts = {}): Promise<boolean> {
    const stampedAt = (opts.now ?? new Date()).toISOString()
    if (opts.eventTs !== undefined) {
      const blocked = await this.db.query(
        'select 1 from portal_tombstone where member_id = $1 and deleted_ts >= $2 limit 1',
        [tokens.memberId, opts.eventTs]
      )
      if (blocked.rows.length > 0) return false // out-of-order install после uninstall — не воскрешаем
    }
    await this.db.query(
      `insert into portal (member_id, domain, tokens, updated_at) values ($1, $2, $3, $4)
       on conflict (member_id) do update
         set tokens = excluded.tokens, domain = excluded.domain, updated_at = excluded.updated_at`,
      [tokens.memberId, tokens.domain ?? '', this.sealBlob(tokens), stampedAt]
    )
    if (opts.eventTs !== undefined) {
      // Настоящая переустановка (строго новее любого зафиксированного uninstall) — чистим тумбстоун.
      await this.db.query(
        'delete from portal_tombstone where member_id = $1 and deleted_ts < $2',
        [tokens.memberId, opts.eventTs]
      )
    }
    return true
  }

  /**
   * Персист СВЕЖЕЙ пары токенов после refresh — **UPDATE-only** (никогда INSERT): если строка
   * портала исчезла под конкурентным uninstall, UPDATE затрагивает 0 строк и возвращает `false`
   * (портал остаётся удалён — второй, независимый от тумбстоуна гард против воскрешения; вызывающий
   * трактует `false` как «портал ушёл»). `true` — токены записаны. Штампует `updated_at`.
   */
  async updateOnRefresh(tokens: OAuthTokens, now: Date = new Date()): Promise<boolean> {
    const r = await this.db.query(
      'update portal set tokens = $1, domain = $2, updated_at = $3 where member_id = $4 returning member_id',
      [this.sealBlob(tokens), tokens.domain ?? '', now.toISOString(), tokens.memberId]
    )
    return r.rows.length > 0
  }

  /**
   * Удаление портала при ONAPPUNINSTALL. В ТРАНЗАКЦИИ (если драйвер умеет): СНАЧАЛА пишет тумбстоун
   * `(member_id, deleted_ts)` (`greatest` при повторной доставке — хранит новейший uninstall),
   * ПОТОМ каскадно удаляет данные портала в порядке зависимостей (FK на `portal(id)` — без
   * `on delete cascade`, поэтому чистим вручную; `response` каскадит свои answer/product/insight).
   * `deletedTs` — unix-СЕКУНДЫ (top-level `ts` вебхука). Требование Маркета: uninstall стирает PII.
   */
  async deletePortal(memberId: string, deletedTs: number): Promise<void> {
    const pidSub = '(select id from portal where member_id = $1)'
    await this.inTx(async (db) => {
      await db.query(
        `insert into portal_tombstone (member_id, deleted_ts) values ($1, $2)
         on conflict (member_id) do update set deleted_ts = greatest(portal_tombstone.deleted_ts, excluded.deleted_ts)`,
        [memberId, deletedTs]
      )
      // Порядок: дети → родители. response и invitation ссылаются на survey/version, поэтому раньше.
      await db.query(`delete from response where portal_id = ${pidSub}`, [memberId])
      await db.query(`delete from invitation where portal_id = ${pidSub}`, [memberId])
      const groupScope = `g.portal_id = ${pidSub}`
      await db.query(
        `delete from survey_option where question_id in (
           select q.id from survey_question q
           join survey_version v on q.version_id = v.id
           join survey s on v.survey_id = s.id
           join survey_group g on s.group_id = g.id where ${groupScope})`,
        [memberId]
      )
      await db.query(
        `delete from survey_question where version_id in (
           select v.id from survey_version v
           join survey s on v.survey_id = s.id
           join survey_group g on s.group_id = g.id where ${groupScope})`,
        [memberId]
      )
      await db.query(
        `delete from survey_version where survey_id in (
           select s.id from survey s join survey_group g on s.group_id = g.id where ${groupScope})`,
        [memberId]
      )
      await db.query(
        `delete from survey where group_id in (select id from survey_group where portal_id = ${pidSub})`,
        [memberId]
      )
      await db.query(`delete from survey_group where portal_id = ${pidSub}`, [memberId])
      await db.query(`delete from app_user where portal_id = ${pidSub}`, [memberId])
      await db.query('delete from portal where member_id = $1', [memberId])
    })
  }

  /**
   * member_id порталов в «полосе у истечения» refresh_token — для keep-alive-рефреша:
   * `updated_at` старше `now - (ttlDays - skewDays)` (пора освежать), но не старше
   * `now - ttlDays` (нижняя граница отсекает уже мёртвые/отозванные гранты, иначе они бы
   * монополизировали батч с фиксированным `updated_at`). Сортировка по возрасту, кап батча.
   */
  async listNearExpiry(now: Date = new Date(), opts: NearExpiryOpts = {}): Promise<string[]> {
    const ttlDays = opts.ttlDays ?? REFRESH_TTL_DAYS
    const skewDays = opts.skewDays ?? KEEPALIVE_SKEW_DAYS
    const limit = opts.limit ?? 50
    const cutoffOld = new Date(now.getTime() - (ttlDays - skewDays) * DAY_MS).toISOString()
    const ttlFloor = new Date(now.getTime() - ttlDays * DAY_MS).toISOString()
    const r = await this.db.query<{ member_id: string }>(
      `select member_id from portal where updated_at < $1 and updated_at >= $2
       order by updated_at asc limit $3`,
      [cutoffOld, ttlFloor, limit]
    )
    return r.rows.map((row) => row.member_id)
  }

  /**
   * Читает и расшифровывает токены портала; undefined — портал не установлен.
   * При повреждении blob / расшифровке другим ключом бросает `OAuthError`
   * (а не «голый» crypto/Zod-error) — чтобы вызывающий мог ловить единый тип.
   */
  async load(memberId: string): Promise<OAuthTokens | undefined> {
    const r = await this.db.query<{ tokens: unknown }>(
      'select tokens from portal where member_id = $1 limit 1',
      [memberId]
    )
    const row = r.rows[0]
    if (!row) return undefined
    try {
      // jsonb драйвер отдаёт уже разобранным объектом (pg.Pool и pglite одинаково)
      const blob = encryptedBlobSchema.parse(row.tokens)
      return oauthTokensSchema.parse(JSON.parse(this.cipher.open(blob)))
    } catch {
      // Сообщение без содержимого токенов: только идентификатор портала.
      throw new OAuthError(`Не удалось прочитать токены портала ${memberId} (повреждение или другой ключ шифрования)`)
    }
  }

  /**
   * Действующий access-token портала: если протух (с запасом REFRESH_SKEW_MS) —
   * рефрешит через OAuth, перешифровывает и сохраняет (`updateOnRefresh`, UPDATE-only).
   * undefined — портал не установлен ИЛИ удалён под гонкой во время refresh (persist 0 строк).
   * Бросает OAuthError, если refresh не удался.
   */
  async accessToken(memberId: string, oauth: Bitrix24OAuth, now: Date = new Date()): Promise<string | undefined> {
    const tokens = await this.load(memberId)
    if (!tokens) return undefined
    if (new Date(tokens.expiresAt).getTime() - REFRESH_SKEW_MS > now.getTime()) {
      return tokens.accessToken
    }
    const refreshed = await oauth.refresh(tokens.refreshToken)
    // Защита от записи в чужой tenant, если сервер вернул другой member_id.
    if (refreshed.memberId !== memberId) {
      throw new OAuthError(`OAuth вернул токены чужого портала (ожидали ${memberId})`)
    }
    // Портал мог быть удалён (uninstall) во время refresh — не отдаём токен «мёртвого» портала.
    if (!(await this.updateOnRefresh(refreshed, now))) return undefined
    return refreshed.accessToken
  }
}
