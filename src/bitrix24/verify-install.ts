import { OAuthError, type OAuthTokens } from './oauth'
import type { InstallAuth } from './install'

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
 * а НЕ присланный (присланный refresh_token после рефреша мёртв). Рефреш возвращает authoritative
 * `member_id` (сверяем) и часто `domain`/`client_endpoint` — `applyVerifiedTokens` привязывает
 * authoritative `domain` (частичное закрытие domain-poisoning; полное — UNIQUE(domain), follow-up);
 * `application_token` рефреш НЕ возвращает — доклеивается из install-auth.
 *
 * Fail-closed: mismatch / явный отказ гранта (400 `invalid_grant` / 401) → 403 (подделка); сеть / 5xx /
 * **429 rate-limit** / пустой member_id → 503 (транзиент/инфра — НЕ ложно-отвергаем легитимную установку,
 * оператор ретраит). Классификация по HTTP-статусу `OAuthError.status` (машинный), не по тексту.
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
    // Только явные auth-отказы (400 invalid_grant / 401) → 403 (подделанный/отозванный грант).
    // Остальное (429 rate-limit, 5xx, сеть) — транзиент → 503 (fail-closed, ретраибельно, не ложно-отвергаем).
    if (status === 400 || status === 401) {
      return { ok: false, status: 403, reason: `refresh_rejected_${status}` }
    }
    return { ok: false, status: 503, reason: 'refresh_unavailable' }
  }
  if (!refreshed.memberId) return { ok: false, status: 503, reason: 'no_member_id' }
  if (refreshed.memberId !== claimedMemberId) {
    // Authoritative member_id гранта ≠ заявленному в POST → отравление чужим member_id.
    return { ok: false, status: 403, reason: 'member_mismatch' }
  }
  return { ok: true, tokens: refreshed }
}

/**
 * Готовит `InstallAuth` для сохранения/регистрации из ВОЗВРАЩЁННОГО (ротированного) гранта: свежие
 * access/refresh + пересчитанный `expiresIn`; authoritative `domain`/`clientEndpoint` из гранта, если
 * Bitrix их вернул (иначе фолбэк на install-auth). Абсолютный `expires` (из ДОрефрешевого гранта, только
 * у event-формата) СБРАСЫВАЕТСЯ — иначе `installToB24Params` взял бы стухшее значение (`expires ?? …`)
 * вместо пересчёта из свежего `expiresIn`. `application_token` и прочие поля сохраняются из install-auth.
 * Чистая (DI-часы) — под тестами; сборка вынесена из Nitro-хендлера, где логика не покрывается юнитами.
 */
export function applyVerifiedTokens(auth: InstallAuth, tokens: OAuthTokens, now: Date = new Date()): InstallAuth {
  // 60с-пол: защита от 0/отрицательного `expiresIn` при рассинхроне часов («грант уже истёк»).
  const remainingSec = Math.max(60, Math.round((new Date(tokens.expiresAt).getTime() - now.getTime()) / 1000))
  const { expires: _staleExpires, ...rest } = auth
  return {
    ...rest,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: remainingSec,
    domain: tokens.domain ?? auth.domain,
    clientEndpoint: tokens.clientEndpoint ?? auth.clientEndpoint
  }
}
