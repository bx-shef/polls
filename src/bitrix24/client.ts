import { B24OAuth } from '@bitrix24/b24jssdk'
import type { EntityType } from '../domain/schema'

/**
 * Серверный REST-клиент портала Bitrix24 на ОФИЦИАЛЬНОМ `@bitrix24/b24jssdk` (`B24OAuth`) —
 * общая основа исходящих вызовов к порталу (`crm.deal.get` #17, обогащение имён, `event.bind`,
 * `app.info`). `B24OAuth` — серверный класс для OAuth-приложений с сохранённым токеном: сам
 * рулит лимитами/повторами/refresh (через `setCallbackRefreshAuth` → персист в `PortalTokenStore`,
 * wiring — слой установки #17). Полный набор токенов (`B24OAuthParams`) берётся из install-обмена.
 *
 * Тонкие хелперы вокруг SDK: единый разбор `AjaxResult` (`isSuccess`/`getData`/`getErrorMessages`)
 * в `result | throw`. Тестируются через структурный `PortalClient` (мок без сети); реальный
 * `B24OAuth` ему удовлетворяет.
 */

/** Параметры/секрет конструктора `B24OAuth` (из b24jssdk; без ре-экспорта приватных типов SDK). */
export type B24OAuthParams = ConstructorParameters<typeof B24OAuth>[0]
export type B24OAuthSecret = ConstructorParameters<typeof B24OAuth>[1]

/** Ошибка REST-вызова портала (без утечки токена в сообщение). */
export class Bitrix24CallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Bitrix24CallError'
  }
}

/** Результат `callMethod` SDK — минимум, который мы читаем (`AjaxResult` ему удовлетворяет). */
export interface CallResult {
  isSuccess: boolean
  getData(): unknown
  getErrorMessages(): string[]
}
/** Минимальный портальный клиент: `B24OAuth`/`B24Hook`/`B24Frame` удовлетворяют структурно. */
export interface PortalClient {
  callMethod(method: string, params?: object, start?: number): Promise<CallResult>
}

/** Создать серверный портальный клиент (b24jssdk `B24OAuth`) из сохранённых токенов + секрета приложения. */
export function createPortalClient(auth: B24OAuthParams, secret: B24OAuthSecret): B24OAuth {
  return new B24OAuth(auth, secret)
}

/**
 * Вызвать REST-метод портала → `result`. Бросает `Bitrix24CallError` на неуспехе/пустом ответе.
 * Разбор конверта Bitrix (`AjaxResult.getData() → { result, time }`) — здесь, чтобы вызывающий
 * работал с чистым `result`.
 */
export async function callMethod<T = unknown>(client: PortalClient, method: string, params: object = {}): Promise<T> {
  const res = await client.callMethod(method, params)
  if (!res.isSuccess) {
    throw new Bitrix24CallError(res.getErrorMessages().join('; ') || `Bitrix24 ${method}: ошибка`)
  }
  const data = res.getData() as { result?: T } | null | undefined
  if (!data || data.result === undefined) {
    throw new Bitrix24CallError(`Bitrix24 ${method}: пустой ответ`)
  }
  return data.result
}

/** `crm.deal.get` → поля сделки (для `dealToCrmContext`, #17). */
export function dealGet(client: PortalClient, dealId: number): Promise<Record<string, unknown>> {
  return callMethod<Record<string, unknown>>(client, 'crm.deal.get', { id: dealId })
}

/**
 * `tasks.task.get` → поля задачи (для `taskToCrmContext`, ручной запуск из карточки задачи).
 * Результат вложен (`{ task }` в REST v2 / `{ item }` в v3) — разворачиваем во внутренний объект.
 * `select` запрашивает явно нужные поля + `UF_CRM_TASK`/`crmItemIds` (по умолчанию не отдаются).
 */
export async function taskGet(client: PortalClient, taskId: number): Promise<Record<string, unknown>> {
  // `*` тянет стандартные поля (вкл. v3 `crmItemIds`/`responsible`); `UF_CRM_TASK` (легаси-привязка)
  // по умолчанию НЕ возвращается — запрашиваем явно. Точный набор сверить на портале (#issue live-smoke).
  const result = await callMethod<Record<string, unknown>>(client, 'tasks.task.get', {
    taskId,
    select: ['*', 'UF_CRM_TASK']
  })
  const inner = (result.task ?? result.item ?? result) as Record<string, unknown>
  return inner
}

/** CRM-сущности, догружаемые через `crm.*.get` (всё, кроме `task` — у задачи свой путь `taskGet`). */
export type CrmEntityType = Exclude<EntityType, 'task'>

/**
 * REST-метод догрузки полей по типу CRM-сущности (binding-слой #34). `deal` включён для удобства
 * единого пути `entityGet(c,'deal',id)`, хотя в боевом deal-флоу обычно зовётся `dealGet`/`dealToCrmContext`.
 * `spa` здесь нет — у него отдельный метод (`crm.item.get` с `entityTypeId`), ветка ниже.
 */
const ENTITY_GET_METHOD: Record<Exclude<CrmEntityType, 'spa'>, string> = {
  deal: 'crm.deal.get',
  lead: 'crm.lead.get',
  contact: 'crm.contact.get',
  company: 'crm.company.get'
}

/**
 * Догрузка полей CRM-сущности по типу (для `entityToCrmContext`, #34). Сделка/лид/контакт/компания —
 * `crm.<entity>.get({id})`; смарт-процесс (`spa`) — `crm.item.get({entityTypeId, id})` (нужен
 * `spaEntityTypeId`) с разворотом `{ item }`. Задача (`task`) идёт отдельным путём (`taskGet`) — здесь
 * не поддержана. Вызывать токеном портала ТОЛЬКО после верификации события (анти-форджери/IDOR).
 */
export async function entityGet(
  client: PortalClient,
  entityType: CrmEntityType,
  id: number,
  spaEntityTypeId?: number
): Promise<Record<string, unknown>> {
  if (entityType === 'spa') {
    if (!spaEntityTypeId) throw new Bitrix24CallError('entityGet: для spa нужен spaEntityTypeId')
    const result = await callMethod<Record<string, unknown>>(client, 'crm.item.get', { entityTypeId: spaEntityTypeId, id })
    // crm.item.get кладёт сущность в `item`; пусто/не-объект (не найдено) → ошибка, а не «тихий» null.
    const item = result.item
    if (!item || typeof item !== 'object') throw new Bitrix24CallError('crm.item.get: пустой item')
    return item as Record<string, unknown>
  }
  return callMethod<Record<string, unknown>>(client, ENTITY_GET_METHOD[entityType], { id })
}

/**
 * Минимальные `B24OAuthParams` из auth фрейма/виджета (есть лишь `domain`+`accessToken`+`memberId`) —
 * для разового вызова от имени пользователя (виджет карточки сделки → `crm.deal.get`, #17).
 * Недостающие поля — безопасные дефолты; refresh не задействуется (один синхронный вызов).
 */
export function frameToB24Params(auth: { domain: string; accessToken: string; memberId: string }): B24OAuthParams {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    applicationToken: '',
    userId: 0,
    memberId: auth.memberId,
    accessToken: auth.accessToken,
    refreshToken: '',
    expires: nowSec + 3600,
    expiresIn: 3600,
    scope: '',
    domain: auth.domain,
    clientEndpoint: `https://${auth.domain}/rest/`,
    serverEndpoint: 'https://oauth.bitrix.info/rest/',
    status: 'L' as B24OAuthParams['status']
  }
}
