import { z } from 'zod'
import { oauthTokensSchema, MAX_EXPIRES_IN, type OAuthTokens } from './oauth'
import type { B24OAuthParams } from './client'

/**
 * Установка приложения на портал (ISSUE #17) — ЯДРО-рантайм. При установке локального/тиражного
 * приложения портал передаёт обработчику набор токенов (`auth`) + `application_token`. Ядро:
 *  - `parseInstallEvent` — мягкий zod-парс недоверенного POST установки;
 *  - `installToTokens` — нормализация в `OAuthTokens` (что шифруется и хранится `PortalTokenStore`);
 *  - `surveyRobotParams` — параметры робота автоматизации «Запустить опрос» для `bizproc.robot.add`;
 *  - `handleInstall` — оркестрация: сохранить токены → зарегистрировать робот (зависимости инжектируются).
 * HTTP/стор/клиент инжектируются → под тестами без живого портала.
 */

/**
 * Нормализованная install-авторизация — ЕДИНАЯ для двух форматов, которыми Bitrix присылает установку:
 *  - **install-страница** (iframe-обработчик): плоские поля формы `AUTH_ID`/`REFRESH_ID`/`AUTH_EXPIRES`/
 *    `member_id`/`DOMAIN` (+ `DOMAIN` часто в query);
 *  - **событие `ONAPPINSTALL`** (server-to-server): `auth.access_token`/… (несёт `application_token`).
 * `applicationToken` опционален: install-страница его НЕ шлёт — он приходит позже с событием/роботом
 * (захватывается там для верификации). Доп. поля (`scope`/`status`/`expires`/…) — для клиента `B24OAuth`.
 */
export interface InstallAuth {
  accessToken: string
  refreshToken: string
  expiresIn: number
  memberId: string
  domain: string
  applicationToken?: string
  clientEndpoint?: string
  serverEndpoint?: string
  scope?: string
  status?: string
  userId?: number
  expires?: number
}

/** Формат серверного события `ONAPPINSTALL`: `{ auth: { access_token, … } }`. */
const eventAuthSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  expires_in: z.coerce.number().int().positive().max(MAX_EXPIRES_IN),
  member_id: z.string().min(1).max(200),
  domain: z.string().min(1).max(253),
  application_token: z.string().min(1).max(200).optional(),
  client_endpoint: z.string().max(500).optional(),
  server_endpoint: z.string().max(500).optional(),
  scope: z.string().max(500).optional(),
  status: z.string().max(10).optional(),
  user_id: z.coerce.number().int().nonnegative().optional(),
  expires: z.coerce.number().int().nonnegative().max(1e13).optional()
})

/** Формат install-страницы (плоские поля формы; `DOMAIN`/`member_id` могут прийти из query). */
const pageAuthSchema = z.object({
  AUTH_ID: z.string().min(1).max(4096),
  REFRESH_ID: z.string().min(1).max(4096),
  AUTH_EXPIRES: z.coerce.number().int().positive().max(MAX_EXPIRES_IN).optional(),
  member_id: z.string().min(1).max(200),
  DOMAIN: z.string().min(1).max(253),
  application_token: z.string().min(1).max(200).optional(),
  status: z.string().max(10).optional()
})

/**
 * Безопасно распарсить недоверенный POST установки (любого из двух форматов) → `InstallAuth` | `null`.
 * Сначала пробуем event-формат (`auth.*`), затем install-страницу (плоские поля). `raw` — обычно
 * объединение query+body (DOMAIN install-страницы приходит в query).
 */
export function parseInstallEvent(raw: unknown): InstallAuth | null {
  if (raw && typeof raw === 'object' && 'auth' in (raw as Record<string, unknown>)) {
    const e = eventAuthSchema.safeParse((raw as { auth: unknown }).auth)
    if (e.success) {
      const a = e.data
      return {
        accessToken: a.access_token,
        refreshToken: a.refresh_token,
        expiresIn: a.expires_in,
        memberId: a.member_id,
        domain: a.domain,
        applicationToken: a.application_token,
        clientEndpoint: a.client_endpoint,
        serverEndpoint: a.server_endpoint,
        scope: a.scope,
        status: a.status,
        userId: a.user_id,
        expires: a.expires
      }
    }
  }
  const p = pageAuthSchema.safeParse(raw)
  if (p.success) {
    const a = p.data
    return {
      accessToken: a.AUTH_ID,
      refreshToken: a.REFRESH_ID,
      expiresIn: a.AUTH_EXPIRES ?? 3600,
      memberId: a.member_id,
      domain: a.DOMAIN,
      applicationToken: a.application_token,
      status: a.status
    }
  }
  return null
}

/** Нормализация install-авторизации → `OAuthTokens` (с `applicationToken`); `expiresAt` из `expiresIn`. */
export function installToTokens(a: InstallAuth, now: Date = new Date()): OAuthTokens {
  return oauthTokensSchema.parse({
    memberId: a.memberId,
    accessToken: a.accessToken,
    refreshToken: a.refreshToken,
    expiresAt: new Date(now.getTime() + a.expiresIn * 1000).toISOString(),
    domain: a.domain,
    clientEndpoint: a.clientEndpoint,
    applicationToken: a.applicationToken
  })
}

/**
 * Маппинг install-авторизации → `B24OAuthParams` для клиента `B24OAuth` (`createPortalClient`).
 * Недостающие поля получают дефолты (`expires` из `expiresIn`, `serverEndpoint` — официальный oauth,
 * `applicationToken` — пустой, т.к. для исходящих вызовов используется access-token, не он).
 */
export function installToB24Params(a: InstallAuth, now: Date = new Date()): B24OAuthParams {
  const nowSec = Math.floor(now.getTime() / 1000)
  return {
    applicationToken: a.applicationToken ?? '',
    userId: a.userId ?? 0,
    memberId: a.memberId,
    accessToken: a.accessToken,
    refreshToken: a.refreshToken,
    expires: a.expires ?? nowSec + a.expiresIn,
    expiresIn: a.expiresIn,
    scope: a.scope ?? '',
    domain: a.domain,
    clientEndpoint: a.clientEndpoint ?? `https://${a.domain}/rest/`,
    serverEndpoint: a.serverEndpoint ?? 'https://oauth.bitrix.info/rest/',
    status: (a.status ?? 'L') as B24OAuthParams['status']
  }
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
/**
 * Виджет в карточке задачи: ручной запуск опроса по задаче (у задачи нет стадии воронки — только
 * ручной запуск, аналог `CRM_DEAL_DETAIL_ACTIVITY`). `TASK_VIEW_SIDEBAR` — боковая панель карточки;
 * handler получает `PLACEMENT_OPTIONS={taskId}` + `AUTH_ID`. Код сверить на портале `placement.list`.
 */
export const PLACEMENT_TASK_VIEW = 'TASK_VIEW_SIDEBAR'

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
    },
    {
      PLACEMENT: PLACEMENT_TASK_VIEW,
      HANDLER: `${base}/b24/task-widget`,
      TITLE: 'Опрос по задаче',
      LANG_ALL: { en: { TITLE: 'Task survey' }, ru: { TITLE: 'Опрос по задаче' } }
    }
  ]
}

/**
 * Парс `PLACEMENT_OPTIONS` виджета карточки (JSON-СТРОКА или объект) → положительный числовой id
 * сущности. `keys` — порядок ключей-кандидатов (зависит от плейсмента). undefined — мусор/битый JSON/
 * нет id/непозитивный (виджет открыт вне сущности). Общая основа для сделки/задачи и будущих сущностей.
 */
export function parsePlacementEntityId(placementOptions: unknown, keys: readonly string[]): number | undefined {
  let opts: unknown = placementOptions
  if (typeof placementOptions === 'string') {
    try {
      opts = JSON.parse(placementOptions)
    } catch {
      return undefined
    }
  }
  if (typeof opts !== 'object' || opts === null) return undefined
  const o = opts as Record<string, unknown>
  for (const k of keys) {
    if (o[k] == null) continue // null/undefined — пропускаем (паритет с `a ?? b ?? c`)
    const id = Number(o[k])
    if (Number.isInteger(id) && id > 0) return id
  }
  return undefined
}

/** Id сделки из `PLACEMENT_OPTIONS` виджета `CRM_DEAL_DETAIL_ACTIVITY` (`{"ID":"3473"}`). */
export function parsePlacementDealId(placementOptions: unknown): number | undefined {
  return parsePlacementEntityId(placementOptions, ['ID'])
}

/** Id задачи из `PLACEMENT_OPTIONS` виджета `TASK_VIEW_SIDEBAR` (ключ зависит от версии плейсмента). */
export function parsePlacementTaskId(placementOptions: unknown): number | undefined {
  return parsePlacementEntityId(placementOptions, ['taskId', 'TASK_ID', 'ID'])
}

/**
 * Оркестрация установки: нормализовать токены → сохранить → зарегистрировать встройки (робот +
 * плейсменты). Порядок важен: регистрация ПОСЛЕ сохранения токенов (идёт токеном этого же портала).
 * `saveTokens`/`registerIntegrations` инжектируются (Nitro: `PortalTokenStore.save` + серия
 * `client.callMethod('bizproc.robot.add' | 'placement.bind', …)`). Частичный отказ безопасен:
 * повторная установка идемпотентна по стабильным CODE/PLACEMENT; вызывающий может ретраить.
 */
export async function handleInstall(
  auth: InstallAuth,
  deps: {
    saveTokens: (tokens: OAuthTokens) => Promise<void>
    registerIntegrations: (tokens: OAuthTokens) => Promise<void>
    now?: Date
  }
): Promise<OAuthTokens> {
  const tokens = installToTokens(auth, deps.now)
  await deps.saveTokens(tokens)
  await deps.registerIntegrations(tokens)
  return tokens
}
