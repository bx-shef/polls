import { TokenCipher, loadTokenKey } from '~core/bitrix24/crypto'
import { PortalTokenStore } from '~core/bitrix24/portal'
import { createPortalClient, callMethod, type B24OAuthParams, type B24OAuthSecret } from '~core/bitrix24/client'
import { integrationCalls } from '~core/bitrix24/install'
import { resolveTriggerMode } from '~core/bitrix24/trigger-mode'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { usePortalDb, logger } from './api'

/**
 * Серверная обвязка установки приложения Bitrix24 (#17). SERVER-ONLY: `~core/bitrix24` (крипто/
 * токены) сюда импортируется намеренно. Конфиг — из env (`NUXT_B24_CLIENT_ID/SECRET`,
 * `NUXT_BITRIX_TOKEN_KEY`, `DOMAIN`). Fail-closed: без полного конфига — `null` (эндпоинт → 503).
 */

/**
 * Rate-limit install-эндпоинта (§2.3 follow-up, CTO MAJOR-3). Каждый well-formed install-POST порождает
 * ИСХОДЯЩИЙ рефреш на `oauth.bitrix.info` (сверка authoritative member_id) → эндпоинт стал
 * амплификатором: флуд → Bitrix лимитит НАС (429) → keep-alive/легитимные install получают 503. Лимитер
 * гасит потолок ДО исходящего рефреша. Install — редкая операция, потому лимит невысокий. In-memory,
 * на инстанс (общий стор для мульти-инстанса — #4).
 *
 * ⚠️ Потолков ДВА, и второй важнее первого. Пер-IP отвечает на вопрос «не борзеет ли один источник»,
 * но защита здесь — не про справедливость, а про то, чтобы НАШ суммарный исходящий поток к Bitrix не
 * вышел за их лимит. Пока IP схлопывался в адрес прокси, глобальный кап получался сам собой; как
 * только ключ стал реальным адресом клиента, «20 в минуту» превратились в «20 в минуту с каждого
 * адреса» — то есть 20×N исходящих рефрешей, ровно тот сценарий, ради которого лимитер и заводили.
 * Поэтому глобальный кап теперь стоит явно, отдельным лимитером с константным ключом.
 */
const installLimiter = new SlidingWindowLimiter({ limit: 20, windowMs: 60_000 })
const installGlobalLimiter = new SlidingWindowLimiter({ limit: 60, windowMs: 60_000 })
const GLOBAL_KEY = 'all'

/** true — install-запрос допущен (и учтён) обоими потолками; false — лимит исчерпан (→ 429). */
export function allowB24Install(ip: string, now: Date = new Date()): boolean {
  // Порядок важен: сначала пер-IP, иначе один флудер выжигал бы общий счётчик за всех.
  return installLimiter.allow(ip, now) && installGlobalLimiter.allow(GLOBAL_KEY, now)
}

export interface B24AppConfig {
  secret: B24OAuthSecret
  /** База для HANDLER-URL встроек (наш домен), напр. `https://polls.bx-shef.by`. */
  baseUrl: string
}

/** Конфиг приложения из env или `null`, если не задан (fail-closed). */
export function b24AppConfig(): B24AppConfig | null {
  const clientId = process.env.NUXT_B24_CLIENT_ID
  const clientSecret = process.env.NUXT_B24_CLIENT_SECRET
  const domain = process.env.APP_DOMAIN ?? process.env.DOMAIN
  if (!clientId || !clientSecret || !domain) return null
  return { secret: { clientId, clientSecret }, baseUrl: `https://${domain}` }
}

/** `PortalTokenStore` поверх pg + шифр (`NUXT_BITRIX_TOKEN_KEY`); `null` без БД/ключа (fail-closed). */
export async function usePortalTokenStore(): Promise<PortalTokenStore | null> {
  const db = await usePortalDb()
  if (!db) return null
  let cipher: TokenCipher
  try {
    cipher = new TokenCipher(loadTokenKey(process.env))
  } catch (e) {
    // Ключ не задан/невалиден (неверная длина/не-hex) — установка fail-closed (503). ЛОГИРУЕМ причину:
    // иначе «опечатка в ключе» неотличима от «ключ не задан», и оператор гадает, почему установка 503.
    logger.warn('b24_token_key_invalid', { msg: (e as Error).message })
    return null
  }
  return new PortalTokenStore(db, cipher)
}

/**
 * Регистрирует встройки приложения на портале (авто-триггер + плейсменты) клиентом `B24OAuth`.
 * Ошибки КАЖДОЙ регистрации толерируются (лог, не throw): робот недоступен на части тарифов, а
 * плейсменты всё равно дают охват; повторная установка идемпотентна по CODE/PLACEMENT.
 *
 * ⚠️ Но у толерантности есть острый край. Пока регистрировались ОБА пути, падение робота было безвредно —
 * оставалось событие. С `TRIGGER_MODE` путь ровно один, и его падение означает, что авто-триггер мёртв
 * ЦЕЛИКОМ, а установка при этом «успешна». Поэтому провал единственного пути логируется `error` с
 * готовым указанием, что делать, — иначе оператор на младшем тарифе поставит `robot`, увидит зелёную
 * установку и будет ждать приглашений, которых не будет.
 */
export async function registerIntegrations(authParams: B24OAuthParams, cfg: B24AppConfig): Promise<void> {
  const client = await createPortalClient(authParams, cfg.secret)
  // Режим триггера решает, ЧТО регистрировать: включать оба пути сразу = два приглашения на один
  // переход (робот сработает на входе, событие — тем же изменением). Дефолт `event` — на всех тарифах.
  const mode = resolveTriggerMode(process.env.TRIGGER_MODE)
  // Режим применяется ТОЛЬКО здесь, при установке: смена переменной на живом портале ничего не
  // перепривязывает (см. docs/process.md, шаг 1). Пишем его в лог, чтобы по установке было видно,
  // какой путь реально привязан.
  logger.info('b24_trigger_mode', { mode })
  for (const { method, params, soleTrigger } of integrationCalls(mode, cfg.baseUrl)) {
    try {
      await callMethod(client, method, params)
    } catch (e) {
      const reason = (e as Error).message
      if (soleTrigger) {
        // Единственный путь не привязался — авто-триггер не заработает вообще. Это не «пропуск встройки».
        logger.error('b24_trigger_not_registered', {
          method,
          mode,
          detail:
            `Авто-триггер НЕ зарегистрирован (${method}): ${reason}. ` +
            (mode === 'robot'
              ? 'Скорее всего тариф портала без бизнес-процессов — переключите TRIGGER_MODE=event и переустановите приложение.'
              : 'Опросы по стадии запускаться не будут — проверьте скоупы приложения и переустановите его.')
        })
      } else {
        // Толерируем (тариф/повторная установка) — не валим всю установку из-за одной встройки.
        logger.warn('b24_register_skip', { detail: `${method} не зарегистрирован: ${reason}` })
      }
    }
  }
}
