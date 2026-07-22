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
    // Остальное (429 rate-limit, 5xx, сеть/таймаут) — транзиент → 503 (fail-closed, ретраибельно,
    // не ложно-отвергаем). Underlying HTTP-статус подмешан в `reason` для прод-диагностики: на логах
    // отличить «Bitrix нас лимитит 429» от «OAuth-сервер лёг 5xx» от «таймаут/сеть» (без статуса).
    if (status === 400 || status === 401) {
      return { ok: false, status: 403, reason: `refresh_rejected_${status}` }
    }
    return { ok: false, status: 503, reason: status ? `refresh_unavailable_${status}` : 'refresh_unavailable' }
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
  const domain = tokens.domain ?? auth.domain
  // clientEndpoint: грант-`client_endpoint` (authoritative от Bitrix) → иначе ДЕРИВИМ из `domain`
  // (`https://<domain>/rest/`). Клиент-присланный `clientEndpoint` НЕ используем как host НИКОГДА:
  // иначе владелец портала подставил бы внутренний/произвольный URL как endpoint «своего» портала →
  // SSRF при исходящих REST (`registerIntegrations` этого же запроса). Сам `domain` (когда грант его не
  // вернул — берётся присланный) валидируется вызывающим по allowlist `*.bitrix24.*` ДО REST-вызовов.
  const clientEndpoint = tokens.clientEndpoint ?? `https://${domain}/rest/`
  return {
    ...rest,
    // memberId — authoritative-by-construction: verifyInstallMember уже сверил `tokens.memberId === auth.memberId`
    // (и что он непуст). Берём из гранта, чтобы провенанс был из доверенного источника, а не из POST.
    memberId: tokens.memberId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: remainingSec,
    domain,
    clientEndpoint
  }
}

/**
 * Решение по «двойной доставке» установки: Bitrix может слать install-страницу И событие `ONAPPINSTALL`
 * на ТОТ ЖЕ handler URL. `refresh_rejected_*` = присланный `refresh_token` отвергнут OAuth (400/401):
 * ЛИБО легитимная повторная доставка (первый запрос уже консьюмнул+ротировал токен), ЛИБО зонд/подделка
 * с мусорным токеном, ЛИБО мисконфиг `client_secret` (invalid_client → 400). Различить их по одному
 * рефрешу нельзя. Правило: `finish` (→ FINISH_HTML, чтобы браузерная install-страница вызвала
 * BX24.installFinish()) ТОЛЬКО если портал УЖЕ установлен — тогда это гонка, не сбой. Иначе `reject`
 * (видимая ошибка): портала нет → это мисконфиг/битый токен/зонд, и маскировать реальный сбой ложным
 * «успехом» нельзя. `member_mismatch` и транзиент (503) → всегда `reject`.
 *
 * ⚠ Остаточный след (осознанно принят, low-severity): `finish` только при существующем портале ⇒ ответ
 * 200-vs-ошибка раскрывает факт установки тому, кто ЗНАЕТ `member_id` (128-бит хэш портала — не
 * перебираемый; утечка — 1 бит «установлено да/нет», записи в этой ветке НЕ происходит). Полностью закрыть
 * нельзя без регрессии: единый `finish` замаскировал бы мисконфиг `client_secret`, единый `reject` показывал
 * бы ошибку на легитимной гонке. См. docs/improvement-plan.md §2.3 (follow-up).
 */
export function decideInstallDoubleDispatch(reason: string, portalExists: boolean): 'finish' | 'reject' {
  return reason.startsWith('refresh_rejected') && portalExists ? 'finish' : 'reject'
}
