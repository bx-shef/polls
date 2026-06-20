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
 * Оркестрация установки: нормализовать токены → сохранить → зарегистрировать робот. Порядок важен:
 * робот регистрируется ПОСЛЕ сохранения токенов (регистрация идёт токеном этого же портала).
 * `saveTokens`/`registerRobot` инжектируются (Nitro: `PortalTokenStore.save` + `client.callMethod`).
 * Частичный отказ (токены сохранены, робот — нет) безопасен: повторная установка идемпотентна по
 * стабильному `CODE` робота; вызывающий может ретраить установку.
 */
export async function handleInstall(
  ev: InstallEvent,
  deps: {
    saveTokens: (tokens: OAuthTokens) => Promise<void>
    registerRobot: (tokens: OAuthTokens) => Promise<void>
    now?: Date
  }
): Promise<OAuthTokens> {
  const tokens = installToTokens(ev, deps.now)
  await deps.saveTokens(tokens)
  await deps.registerRobot(tokens)
  return tokens
}
