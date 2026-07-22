import { OAuthError, type OAuthTokens } from './oauth'

/** Узкий контракт для DI: боевой `Bitrix24OAuth` его удовлетворяет; тест инжектирует фейк. */
export interface RefreshCapable {
  refresh(refreshToken: string): Promise<OAuthTokens>
}

/**
 * Привязка `member_id` к OAuth-гранту при установке (docs/improvement-plan.md §2.3, анти
 * install-poisoning). Проблема: `member_id` в install-POST — КЛИЕНТ-КОНТРОЛИРУЕМОЕ поле, а
 * `/api/b24/install` апсертит присланные токены без сверки. Владелец любого реального портала A
 * может подделать install с чужим `member_id` + своими валидными токенами портала A → отравит
 * tenant-ключ жертвы (targeted cross-tenant). С §2.1 (uninstall) последствие вырастает с DoS до
 * УДАЛЕНИЯ ДАННЫХ жертвы. Защита: рефрешим присланный `refresh_token` — OAuth-сервер Bitrix
 * возвращает **authoritative** `member_id` гранта, который ОБЯЗАН совпасть с заявленным.
 *
 * В отличие от донора (SDK-рефреш выбрасывает member_id → нужен сырой POST), наш `Bitrix24OAuth`
 * — свой fetch-клиент: `refresh()` парсит `member_id` из ответа токен-эндпоинта напрямую.
 *
 * Refresh **РОТИРУЕТ** токен ⇒ на успехе вызывающий хранит ВОЗВРАЩЁННЫЙ грант (`verdict.tokens`),
 * а НЕ присланный (присланный refresh_token после рефреша мёртв). `application_token`/`domain`
 * рефреш не возвращает — вызывающий доклеивает их из install-auth.
 *
 * Fail-closed: mismatch / отказ гранта (4xx `invalid_grant`) → 403 (подделка); сеть/5xx/пустой
 * member_id → 503 (инфра — НЕ ложно-отвергаем легитимную установку, оператор ретраит). Классификация
 * по HTTP-статусу `OAuthError.status` (машинный), не по тексту.
 */

export type InstallMemberVerdict =
  | { ok: true; tokens: OAuthTokens }
  | { ok: false; status: 403 | 503; reason: string }

export async function verifyInstallMember(
  claimedMemberId: string,
  refreshToken: string,
  oauth: RefreshCapable
): Promise<InstallMemberVerdict> {
  let refreshed: OAuthTokens
  try {
    refreshed = await oauth.refresh(refreshToken)
  } catch (e) {
    const status = e instanceof OAuthError ? e.status : undefined
    // 4xx (invalid_grant/invalid_token) — подделанный/отозванный грант → 403.
    if (status !== undefined && status >= 400 && status < 500) {
      return { ok: false, status: 403, reason: `refresh_rejected_${status}` }
    }
    // Сеть (нет status) / 5xx — инфра → 503 (fail-closed, не ложно-отвергаем легитимную установку).
    return { ok: false, status: 503, reason: 'refresh_unavailable' }
  }
  if (!refreshed.memberId) return { ok: false, status: 503, reason: 'no_member_id' }
  if (refreshed.memberId !== claimedMemberId) {
    // Authoritative member_id гранта ≠ заявленному в POST → отравление чужим member_id.
    return { ok: false, status: 403, reason: 'member_mismatch' }
  }
  return { ok: true, tokens: refreshed }
}
