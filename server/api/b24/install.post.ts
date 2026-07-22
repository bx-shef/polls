// POST /api/b24/install — установка приложения на портал Bitrix24 (#17). Bitrix присылает установку
// либо install-страницей (плоские поля формы AUTH_ID/REFRESH_ID/member_id, DOMAIN в query), либо
// событием ONAPPINSTALL (auth.access_token). parseInstallEvent понимает оба формата. Плюс ветка
// ONAPPUNINSTALL (§2.1, ПЕРВЫМ шагом): она fail-OPEN — ВСЕГДА 200 (B24 не ретраит online-события),
// сбои только в логах (b24_uninstall_*). Install-ветка ниже — fail-closed (503 без конфига/БД/ключа).
//
// Конвейер: merge(query, body) → parseInstallEvent → handleInstall(сохранить токены PortalTokenStore →
// зарегистрировать робот+плейсменты B24OAuth). Ответ — HTML, вызывающий BX24.installFinish() (портал
// помечает установку завершённой); на ошибке — HTML с текстом. Fail-closed: без конфига/БД/ключа — 503.
import { parseInstallEvent, installToB24Params, handleInstall } from '~core/bitrix24/install'
import { parseUninstallEvent, decideUninstall } from '~core/bitrix24/uninstall'
import { parseBracketForm } from '~core/bitrix24/bracket-form'
import { verifyInstallMember, applyVerifiedTokens, decideInstallDoubleDispatch } from '~core/bitrix24/verify-install'
import { Bitrix24OAuth, type HttpFetch, type HttpResponse } from '~core/bitrix24/oauth'
import { isAllowedPortalDomain } from '~core/bitrix24/frame'
import { errInfo } from '~core/obs/logger'
import { b24AppConfig, usePortalTokenStore, registerIntegrations, allowB24Install } from '../../utils/portal'
import { logger } from '../../utils/api'

/**
 * Верификационный рефреш — СИНХРОННЫЙ исходящий вызов на `oauth.bitrix.info` внутри install-запроса.
 * Ядро (`Bitrix24OAuth`) делегирует таймауты «слою деплоя»; здесь этот слой — мы. Без явного лимита
 * зависший OAuth-сервер держал бы install-соединение до дефолта undici (~300с) и (с флудом) подъедал бы
 * сокеты/event-loop. `AbortSignal.timeout` → fetch reject → OAuthError без статуса → 503 (транзиент, ретрай).
 */
const OAUTH_REFRESH_TIMEOUT_MS = 10_000
const timeoutRefreshFetch: HttpFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS) }) as Promise<HttpResponse>

function html(event: any, status: number, body: string): string {
  setResponseStatus(event, status)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return body
}

/** Страница, завершающая установку в портале (BX24.installFinish). */
const FINISH_HTML = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<script src="//api.bitrix24.com/api/v1/"></script></head>
<body><p>Приложение установлено. Можно закрыть это окно.</p>
<script>try{BX24.init(function(){BX24.installFinish();});}catch(e){}</script></body></html>`

const errorHtml = (msg: string): string =>
  `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"></head><body><p>Установка не завершена: ${msg}</p></body></html>`

export default defineEventHandler(async (event) => {
  // DOMAIN install-страницы приходит в query; токены — в теле. Объединяем.
  const body = await readBody(event).catch(() => ({}))
  const merged = { ...getQuery(event), ...(body && typeof body === 'object' ? body : {}) }

  // ── ONAPPUNINSTALL (§2.1): Bitrix шлёт lifecycle-события на тот же handler URL. Обрабатываем
  //    ПЕРВЫМ, до install-парса (bracket-form-тело → вложенный объект). Не наш формат → падаем в
  //    install (поведение install БЕЗ изменений). B24 online-события НЕ ретраит → всегда отвечаем 200.
  const uninstall = parseUninstallEvent(parseBracketForm(merged as Record<string, unknown>))
  if (uninstall) {
    const store = await usePortalTokenStore()
    if (!store) {
      // Не смогли обработать (нет БД/ключа) — B24 не повторит. ERROR-лог для ручной сверки.
      logger.error('b24_uninstall_no_store', { memberId: uninstall.auth.member_id })
      return html(event, 200, 'ok')
    }
    try {
      // application_token — из зашифрованного blob токенов портала; сверка constant-time в decideUninstall.
      const tokens = await store.load(uninstall.auth.member_id)
      const verdict = decideUninstall(uninstall, tokens?.applicationToken, Math.floor(Date.now() / 1000))
      if (!verdict.ok) {
        // Форджери/неизвестный портал — ничего не удаляем, 200 без раскрытия причины наружу.
        logger.warn('b24_uninstall_reject', { memberId: uninstall.auth.member_id, reason: verdict.reason })
        return html(event, 200, 'ok')
      }
      if (verdict.clean) await store.deletePortal(verdict.memberId, verdict.deletedTs)
      logger.info('b24_uninstall_ok', { memberId: verdict.memberId, cleaned: verdict.clean })
    } catch (e) {
      // Транзиентный сбой (БД/повреждённый blob) — B24 online-события НЕ ретраит. ERROR-лог для ручной
      // сверки пропущенного удаления PII; всё равно отвечаем 200 (сохраняем инвариант ответа).
      logger.error('b24_uninstall_error', { memberId: uninstall.auth.member_id, reason: errInfo(e).message })
    }
    return html(event, 200, 'ok')
  }

  const auth = parseInstallEvent(merged)
  if (!auth) {
    // Диагностика: какие ключи реально прислал портал (значения-секреты НЕ логируем).
    logger.warn('b24_install_parse_fail', { msg: `Неизвестный формат установки; ключи: ${Object.keys(merged).join(',')}` })
    return html(event, 400, errorHtml('некорректные параметры установки'))
  }

  const cfg = b24AppConfig()
  const tokenStore = await usePortalTokenStore()
  if (!cfg || !tokenStore) {
    return html(event, 503, errorHtml('интеграция не сконфигурирована на сервере'))
  }

  // Rate-limit ДО исходящего верификационного рефреша (§2.3 follow-up, CTO MAJOR-3): install-эндпоинт —
  // амплификатор (well-formed POST → рефреш на oauth.bitrix.info). Применяем на install-пути (uninstall
  // выше уже ответил и вышел — его НЕ лимитируем, B24 online-события не ретраит). IP за прокси — #4.
  if (!allowB24Install(getRequestIP(event) ?? '?')) {
    logger.warn('b24_install_ratelimited', { memberId: auth.memberId })
    return html(event, 429, errorHtml('слишком много попыток установки — повторите позже'))
  }

  // §2.3 member_id-binding (анти install-poisoning): member_id в POST — клиент-контролируемое поле.
  // Рефрешим присланный refresh_token и сверяем AUTHORITATIVE member_id из ответа OAuth-сервера с
  // заявленным. Без этого атакующий подсадил бы свои токены на чужой member_id → с §2.1 удалил бы данные.
  const oauth = new Bitrix24OAuth({
    clientId: cfg.secret.clientId,
    clientSecret: cfg.secret.clientSecret,
    fetch: timeoutRefreshFetch
  })
  const memberVerdict = await verifyInstallMember(auth.memberId, auth.refreshToken, oauth)
  if (!memberVerdict.ok) {
    // Идемпотентность двойной доставки (install-страница + событие ONAPPINSTALL на ТОТ ЖЕ URL). Решение —
    // в чистой `decideInstallDoubleDispatch`: `refresh_rejected_*` + УЖЕ установленный портал → гонка →
    // FINISH_HTML (браузерная install-страница вызовет BX24.installFinish()); иначе → видимая ошибка (не
    // маскируем мисконфиг/подделку). Портал грузим ТОЛЬКО на refresh_rejected (503-транзиент БД не трогает).
    const isRejected = memberVerdict.reason.startsWith('refresh_rejected')
    const portalExists = isRejected && !!(await tokenStore.load(auth.memberId).catch(() => undefined))
    if (decideInstallDoubleDispatch(memberVerdict.reason, portalExists) === 'finish') {
      logger.info('b24_install_double_dispatch', { memberId: auth.memberId })
      return html(event, 200, FINISH_HTML)
    }
    logger.warn('b24_install_member_reject', { memberId: auth.memberId, reason: memberVerdict.reason })
    return html(
      event,
      memberVerdict.status,
      errorHtml(
        memberVerdict.status === 403
          ? 'проверка привязки портала не пройдена'
          : 'сервер авторизации Bitrix24 недоступен — повторите установку'
      )
    )
  }
  // refresh РОТИРОВАЛ токены — используем ВОЗВРАЩЁННЫЙ грант везде (присланный refresh_token мёртв).
  // Сборка вынесена в чистую applyVerifiedTokens (пересчёт expiresIn, сброс stale expires, authoritative
  // domain; clientEndpoint деривится из domain, application_token сохранён из install-auth).
  const verifiedAuth = applyVerifiedTokens(auth, memberVerdict.tokens)

  // SSRF-гард (§2.3 follow-up): domain станет host'ом исходящих REST (registerIntegrations → clientEndpoint).
  // Если грант не вернул authoritative domain — в verifiedAuth.domain присланное значение. Пускаем на REST
  // ТОЛЬКО облачные хосты Bitrix (`*.bitrix24.<tld>`), иначе владелец портала увёл бы вызовы на внутренний URL.
  if (!isAllowedPortalDomain(verifiedAuth.domain)) {
    logger.warn('b24_install_bad_domain', { memberId: verifiedAuth.memberId, domain: verifiedAuth.domain })
    return html(event, 400, errorHtml('недопустимый домен портала'))
  }

  try {
    await handleInstall(verifiedAuth, {
      // save → Promise<boolean> (durable-гард по member_id). Тумбстоун-гард против out-of-order install
      // (eventTs) здесь НЕ передаётся — активируется на events-пути §2.1 (там есть top-level `ts`).
      saveTokens: async (tokens) => {
        await tokenStore.save(tokens)
      },
      registerIntegrations: () => registerIntegrations(installToB24Params(verifiedAuth), cfg)
    })
    logger.info('b24_install_ok', { msg: `Установка портала ${auth.memberId} завершена (member_id сверен)` })
    return html(event, 200, FINISH_HTML)
  } catch (e) {
    logger.warn('b24_install_fail', { msg: `Установка не завершена: ${(e as Error).message}` })
    return html(event, 502, errorHtml('ошибка при сохранении/регистрации'))
  }
})
