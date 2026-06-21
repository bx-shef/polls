import { z } from 'zod'
import { oauthTokensSchema, MAX_EXPIRES_IN, type OAuthTokens } from './oauth'

/**
 * Установка приложения на портал (ISSUE #17) — ЯДРО-рантайм. При установке локального/тиражного
 * приложения портал передаёт обработчику набор токенов (`auth`) + `application_token`. Ядро:
 *  - `parseInstallEvent` — мягкий zod-парс недоверенного POST установки;
 *  - `installToTokens` — нормализация в `OAuthTokens` (что шифруется и хранится `PortalTokenStore`);
 *  - `surveyRobotParams` — параметры робота автоматизации «Запустить опрос» для `bizproc.robot.add`;
 *  - `handleInstall` — оркестрация: сохранить токены → зарегистрировать робот (зависимости инжектируются).
 * HTTP/стор/клиент инжектируются → под тестами без живого портала.
 */

/** Недоверенный POST установки (минимум; прочие поля игнорируются). `MAX_EXPIRES_IN` — общий с oauth. */
export const installEventSchema = z.object({
  auth: z.object({
    access_token: z.string().min(1).max(4096),
    refresh_token: z.string().min(1).max(4096),
    expires_in: z.coerce.number().int().positive().max(MAX_EXPIRES_IN),
    member_id: z.string().min(1).max(200),
    domain: z.string().min(1).max(253),
    application_token: z.string().min(1).max(200),
    client_endpoint: z.string().max(500).optional()
  })
})
export type InstallEvent = z.infer<typeof installEventSchema>

/** Безопасно распарсить POST установки → `InstallEvent` или `null` (мусор/неполнота). */
export function parseInstallEvent(raw: unknown): InstallEvent | null {
  const r = installEventSchema.safeParse(raw)
  return r.success ? r.data : null
}

/** Нормализация install-`auth` → `OAuthTokens` (с `applicationToken`); `expiresAt` из `expires_in`. */
export function installToTokens(ev: InstallEvent, now: Date = new Date()): OAuthTokens {
  const a = ev.auth
  return oauthTokensSchema.parse({
    memberId: a.member_id,
    accessToken: a.access_token,
    refreshToken: a.refresh_token,
    expiresAt: new Date(now.getTime() + a.expires_in * 1000).toISOString(),
    domain: a.domain,
    clientEndpoint: a.client_endpoint,
    applicationToken: a.application_token
  })
}

/** Уникальный код робота автоматизации приложения (стабилен — повторная установка обновляет). */
export const SURVEY_ROBOT_CODE = 'polls_launch_survey'

/**
 * Параметры `bizproc.robot.add` для робота «Запустить опрос» на сделках. Пользователь портала
 * ставит его на нужную стадию в правилах автоматизации; при срабатывании Bitrix POST'ит на `HANDLER`.
 * `USE_SUBSCRIPTION:'N'` — опрос асинхронен, ответа процессу не ждём.
 */
export function surveyRobotParams(handlerUrl: string): Record<string, unknown> {
  return {
    CODE: SURVEY_ROBOT_CODE,
    HANDLER: handlerUrl,
    NAME: { ru: 'Запустить опрос', en: 'Launch survey' },
    USE_SUBSCRIPTION: 'N',
    DOCUMENT_TYPE: ['crm', 'CCrmDocumentDeal', 'DEAL'],
    FILTER: { INCLUDE: [['crm', 'CCrmDocumentDeal']] }
  }
}

/**
 * Коды встроек (placement). Робот зависит от тарифа → плейсменты дают охват на ВСЕХ тарифах:
 *  - `CRM_DEAL_DETAIL_ACTIVITY` — виджет в карточке сделки: ручной запуск опроса по сделке
 *    (handler получает `PLACEMENT_OPTIONS={ID: dealId}` + `AUTH_ID`);
 *  - `CRM_ANALYTICS_MENU` — пункт в меню CRM-аналитики: сюда затянут дашборд (без `PLACEMENT_OPTIONS`).
 */
export const PLACEMENT_DEAL_ACTIVITY = 'CRM_DEAL_DETAIL_ACTIVITY'
export const PLACEMENT_ANALYTICS_MENU = 'CRM_ANALYTICS_MENU'

/** Параметры одной встройки для `placement.bind`. */
export interface PlacementSpec {
  PLACEMENT: string
  HANDLER: string
  TITLE: string
  LANG_ALL?: Record<string, { TITLE: string }>
}

/**
 * Встройки приложения для `placement.bind` (по `baseUrl` приложения, напр. `https://polls.bx-shef.by`):
 * виджет запуска опроса в карточке сделки + дашборд в меню CRM-аналитики. HANDLER'ы — на нашем домене.
 */
export function surveyPlacements(baseUrl: string): PlacementSpec[] {
  const base = baseUrl.replace(/\/+$/, '')
  return [
    {
      PLACEMENT: PLACEMENT_DEAL_ACTIVITY,
      HANDLER: `${base}/b24/deal-widget`,
      TITLE: 'Опрос по сделке',
      LANG_ALL: { en: { TITLE: 'Deal survey' }, ru: { TITLE: 'Опрос по сделке' } }
    },
    {
      PLACEMENT: PLACEMENT_ANALYTICS_MENU,
      HANDLER: `${base}/b24/dashboard`,
      TITLE: 'Опросы — аналитика',
      LANG_ALL: { en: { TITLE: 'Surveys — analytics' }, ru: { TITLE: 'Опросы — аналитика' } }
    }
  ]
}

/**
 * Парс `PLACEMENT_OPTIONS` виджета карточки сделки (`CRM_DEAL_DETAIL_ACTIVITY`): приходит JSON-СТРОКОЙ
 * `{"ID":"3473"}` → числовой id сделки. undefined — мусор/нет ID (виджет открыт вне сделки).
 */
export function parsePlacementDealId(placementOptions: unknown): number | undefined {
  let opts: unknown = placementOptions
  if (typeof placementOptions === 'string') {
    try {
      opts = JSON.parse(placementOptions)
    } catch {
      return undefined
    }
  }
  if (typeof opts !== 'object' || opts === null) return undefined
  const id = Number((opts as { ID?: unknown }).ID)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/**
 * Оркестрация установки: нормализовать токены → сохранить → зарегистрировать встройки (робот +
 * плейсменты). Порядок важен: регистрация ПОСЛЕ сохранения токенов (идёт токеном этого же портала).
 * `saveTokens`/`registerIntegrations` инжектируются (Nitro: `PortalTokenStore.save` + серия
 * `client.callMethod('bizproc.robot.add' | 'placement.bind', …)`). Частичный отказ безопасен:
 * повторная установка идемпотентна по стабильным CODE/PLACEMENT; вызывающий может ретраить.
 */
export async function handleInstall(
  ev: InstallEvent,
  deps: {
    saveTokens: (tokens: OAuthTokens) => Promise<void>
    registerIntegrations: (tokens: OAuthTokens) => Promise<void>
    now?: Date
  }
): Promise<OAuthTokens> {
  const tokens = installToTokens(ev, deps.now)
  await deps.saveTokens(tokens)
  await deps.registerIntegrations(tokens)
  return tokens
}
