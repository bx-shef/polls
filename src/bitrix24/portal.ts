import type { Queryable } from '../store/types'
import { TokenCipher, encryptedBlobSchema } from './crypto'
import { Bitrix24OAuth, OAuthError, oauthTokensSchema, type OAuthTokens } from './oauth'

/**
 * Хранилище OAuth-токенов портала (ISSUE #3): пишет/читает `portal.tokens`
 * в зашифрованном виде (TokenCipher) и прозрачно обновляет протухший access-token.
 * Драйвер-агностично (`Queryable` — pg.Pool/pglite), без новой prod-зависимости.
 * tenant — `member_id` портала (Bitrix24-идентификатор).
 *
 * Координация refresh (одновременные вызовы используют один refresh-token; потеря
 * новых токенов при сбое `save()` после успешного refresh) требует общего лока
 * между инстансами — вынесено в #4 (мульти-инстанс) + алертинг в #5. Для single
 * instance до live-связки вреда нет.
 */

/** Запас до истечения: обновляемся заранее, чтобы не отдать почти-протухший токен (60 с). */
const REFRESH_SKEW_MS = 60_000

export class PortalTokenStore {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: TokenCipher
  ) {}

  /** Сохраняет токены портала (upsert по member_id), шифруя перед записью. */
  async save(tokens: OAuthTokens): Promise<void> {
    const blob = JSON.stringify(this.cipher.seal(JSON.stringify(tokens)))
    await this.db.query(
      `insert into portal (member_id, domain, tokens) values ($1, $2, $3)
       on conflict (member_id) do update set tokens = excluded.tokens, domain = excluded.domain`,
      [tokens.memberId, tokens.domain ?? '', blob]
    )
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
   * рефрешит через OAuth, перешифровывает и сохраняет. undefined — портал не
   * установлен. Бросает OAuthError, если refresh не удался.
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
    await this.save(refreshed)
    return refreshed.accessToken
  }
}
