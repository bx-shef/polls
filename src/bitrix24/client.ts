import { B24OAuth } from '@bitrix24/b24jssdk'
import type { EntityType } from '../domain/schema'

/**
 * Серверный REST-клиент портала Bitrix24 на ОФИЦИАЛЬНОМ `@bitrix24/b24jssdk` (`B24OAuth`) —
 * общая основа исходящих вызовов к порталу (`crm.deal.get` #17, обогащение имён, `event.bind`,
 * `profile`). `B24OAuth` — серверный класс для OAuth-приложений с сохранённым токеном: сам
 * рулит лимитами/повторами/refresh. Персист рефреша сейчас идёт через `PortalTokenStore.accessToken`
 * (рефреш ДО построения клиента), а не через SDK-колбэк `setCallbackRefreshAuth` — он не подключён;
 * `frameToB24Params` даёт пустой refreshToken. Полный набор токенов (`B24OAuthParams`) — из install-обмена.
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

/** Конверт ответа SDK (`AjaxResult` ему удовлетворяет): успех + данные + ошибки. */
export interface CallResult {
  isSuccess: boolean
  getData(): unknown
  getErrorMessages(): string[]
}
/**
 * Минимальный портальный клиент: реальные `B24OAuth`/`B24Hook`/`B24Frame` удовлетворяют
 * структурно. Вызов метода — через НЕ-deprecated `actions.v2.call.make` (b24jssdk 2.0; REST v2,
 * как и прежде). Старый `callMethod` помечен deprecated в SDK и здесь больше не используется (#95).
 */
export interface PortalClient {
  actions: {
    v2: { call: { make(options: { method: string; params?: object; requestId?: string }): Promise<CallResult> } }
  }
}

/**
 * Ретрай на уровне ОДНОГО REST-вызова, который делает SDK сам.
 *
 * По умолчанию `@bitrix24/b24jssdk` переигрывает запрос до трёх раз, в том числе на сетевой ошибке и
 * клиентском таймауте. Для чтения это удобно, для записи — источник дублей: если ответ не дошёл, это
 * НЕ значит, что сервер запрос не выполнил. Повтор `crm.activity.configurable.add` создаст второе дело
 * в таймлайне, а Bitrix не гарантирует уникальность по `originId`/`xmlId` — то есть починить постфактум
 * будет нечем.
 *
 * Сегодня мы только читаем, поэтому эффекта нет. Но как только приедет доставка приглашений
 * ([#126](https://github.com/bx-shef/polls/issues/126)), SDK-ретрай станет **вторым, независимым**
 * источником дублей — и идемпотентность по `ID` записи истории стадий ([#138]) его не лечит: это
 * другой уровень. Включать защиту тогда, когда дубли уже пошли к клиенту заказчика, поздно.
 *
 * Поэтому ретрай живёт на НАШЕМ уровне, где он идемпотентен (повторная доставка события, `save` по
 * ключу), а на уровне одного REST-вызова запрещён. Цена честная: сетевой сбой ЧТЕНИЯ больше не
 * переигрывается сам — вызывающий обязан это пережить. У `confirmStageEntry` так и есть: ошибка гасится
 * в `false`, то есть приглашение просто не создаётся (это уже задокументировано как осознанный выбор).
 */
export const NO_RETRY_PARAMS = { maxRetries: 1, retryOnNetworkError: false } as const

/**
 * Создать серверный портальный клиент (b24jssdk `B24OAuth`) из сохранённых токенов + секрета приложения.
 *
 * ⚠️ Асинхронная НЕ ради конструктора, а ради `setRestrictionManagerParams` — она возвращает Promise, и
 * без `await` настройка могла бы не примениться до первого вызова. Тихо «почти отключённый» ретрай —
 * ровно то, чего мы избегаем.
 */
export async function createPortalClient(auth: B24OAuthParams, secret: B24OAuthSecret): Promise<B24OAuth> {
  const client = new B24OAuth(auth, secret)
  await client.setRestrictionManagerParams({ ...NO_RETRY_PARAMS })
  return client
}

/**
 * Вызвать REST-метод портала → `result`. Бросает `Bitrix24CallError` на неуспехе/пустом ответе.
 * Разбор конверта Bitrix (`AjaxResult.getData() → { result, time }`) — здесь, чтобы вызывающий
 * работал с чистым `result`.
 */
export async function callMethod<T = unknown>(client: PortalClient, method: string, params: object = {}): Promise<T> {
  const res = await client.actions.v2.call.make({ method, params })
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
 * `crm.deal.productrows.get` → товарные позиции сделки (`PRODUCT_ID`/`PRODUCT_NAME`, для `products`
 * снимка `CrmContext` → срез дашборда «услуга/товар», #17). Best-effort: у сделки товаров может не быть.
 */
export function dealProductRows(client: PortalClient, dealId: number): Promise<Array<Record<string, unknown>>> {
  return callMethod<Array<Record<string, unknown>>>(client, 'crm.deal.productrows.get', { id: dealId })
}

/**
 * Параметры запроса истории стадий — ОТДЕЛЬНО от вызова, чтобы живой smoke (`scripts/b24-smoke.ts`)
 * бил ровно тем же запросом, что прод. Иначе смысл смоука теряется: он объявлен гейтом формата, но
 * сверял бы форму запроса, которой в бою нет (например, без суженного `select` — а именно на нём портал
 * может ответить пустыми полями, и механизм молча перестанет работать).
 */
export function stageHistoryParams(entityTypeId: number, ownerId: number): Record<string, unknown> {
  return {
    entityTypeId,
    order: { ID: 'DESC' },
    filter: { OWNER_ID: ownerId },
    select: ['ID', 'CREATED_TIME', 'STAGE_ID']
  }
}

/**
 * `crm.stagehistory.list` → записи истории движения по стадиям (детекция РЕАЛЬНОГО перехода, #17).
 * Отдельного события смены стадии в Bitrix24 нет, поэтому переход подтверждаем историей портала.
 * Метод отдаёт `{ items: [...] }`; решение принимает чистая `isFreshStageEntry` — ей нужна только
 * последняя запись, которую она находит сама (порядок ответа портала не принимается на веру).
 */
export async function stageHistoryList(
  client: PortalClient,
  entityTypeId: number,
  ownerId: number
): Promise<Array<Record<string, unknown>>> {
  const result = await callMethod<{ items?: Array<Record<string, unknown>> } | undefined>(
    client,
    'crm.stagehistory.list',
    stageHistoryParams(entityTypeId, ownerId)
  )
  // Страница уже получена по сети — резать её здесь нечего экономить, а срез ДО сортировки был бы опасен:
  // если портал когда-нибудь не применит `order`, в срез попали бы САМЫЕ СТАРЫЕ записи и подтверждение
  // перехода перестало бы срабатывать вообще (молча). Порядок восстанавливает `latestRecord` сам.
  return Array.isArray(result?.items) ? result.items : []
}

/** CRM-сущности, догружаемые через `crm.*.get`. Совпадает с `EntityType` (все сущности — CRM-типы). */
export type CrmEntityType = EntityType

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
 * `spaEntityTypeId`) с разворотом `{ item }`. Вызывать токеном портала ТОЛЬКО после верификации
 * события (анти-форджери/IDOR).
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
