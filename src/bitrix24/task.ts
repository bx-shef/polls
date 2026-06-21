import type { CrmContext } from '../domain/schema'
import { posId } from './deal-event'

/**
 * Маппинг задачи (`tasks.task.get`) → снимок `CrmContext` для РУЧНОГО запуска опроса из карточки
 * задачи (плейсмент `TASK_VIEW_*`, ISSUE #17 / мульти-сущность). У задачи нет стадии воронки, поэтому
 * автотриггер по стадии к ней неприменим — запуск только вручную (аналог виджета карточки сделки).
 * Контекст строится из АВТОРИТЕТНОГО ответа REST ТОЛЬКО ПОСЛЕ verifyFrameAuth/проверки сессии портала
 * (анти-форджери на binding-слое, как у deal-event). Чистый маппер, под тестами.
 *
 * Связь задачи с CRM берём из её привязок: REST v3 отдаёт `crmItemIds: ["D_6529","C_45"]`, легаси v2 —
 * `ufCrmTask`/`UF_CRM_TASK` тем же форматом `<PREFIX>_<id>`. Префиксы: D=сделка, C=контакт, CO=компания,
 * L=лид. Лид в `CrmContext` поля не имеет (как у contact/company-датчиков) — игнорируем.
 */

/** Распарсенные CRM-привязки задачи (то, что ложится в `CrmContext`). */
export interface TaskCrmBindings {
  dealId?: number
  contactId?: number
  companyId?: number
}

const BINDING_PREFIX_TO_FIELD: Record<string, keyof TaskCrmBindings> = {
  D: 'dealId',
  C: 'contactId',
  CO: 'companyId'
}

/**
 * Парс привязок задачи к CRM из массива строк `<PREFIX>_<id>` (`crmItemIds`/`ufCrmTask`).
 * Берёт ПЕРВУЮ привязку каждого типа (у задачи может быть несколько). Мусор/неизвестный префикс/
 * лид (`L_`) — пропускаются. Не массив → пустой объект.
 */
export function parseTaskCrmBindings(bindings: unknown): TaskCrmBindings {
  const out: TaskCrmBindings = {}
  if (!Array.isArray(bindings)) return out
  for (const raw of bindings) {
    if (typeof raw !== 'string') continue
    const m = /^([A-Z]+)_(\d+)$/.exec(raw.toUpperCase())
    if (!m) continue
    const field = BINDING_PREFIX_TO_FIELD[m[1]!]
    if (!field || out[field] !== undefined) continue
    const id = posId(m[2])
    if (id !== undefined) out[field] = id
  }
  return out
}

/**
 * `tasks.task.get` → `CrmContext`. Заполняет `responsibleId` (отв. за задачу) + CRM-привязки
 * (`dealId`/`contactId`/`companyId`) из `crmItemIds`/`ufCrmTask`. Имя ответственного — денормализуем,
 * если REST вернул `responsible.name` (PII, как `responsibleName` сделки; редакция — #31).
 * Толерантен к v2 (`responsibleId`/`RESPONSIBLE_ID`) и v3 (`responsible.id`/`responsible.name`).
 * NB: привязки/UF задача отдаёт только при явном `select` (см. `taskGet`) — по умолчанию их нет.
 */
export function taskToCrmContext(task: Record<string, unknown>): CrmContext {
  const ctx: CrmContext = {}

  const responsible = task.responsible as { id?: unknown; name?: unknown } | undefined
  const responsibleId = posId(task.responsibleId ?? task.RESPONSIBLE_ID ?? responsible?.id)
  if (responsibleId !== undefined) ctx.responsibleId = responsibleId
  if (typeof responsible?.name === 'string' && responsible.name) ctx.responsibleName = responsible.name

  const bindings = parseTaskCrmBindings(task.crmItemIds ?? task.ufCrmTask ?? task.UF_CRM_TASK)
  if (bindings.dealId !== undefined) ctx.dealId = bindings.dealId
  if (bindings.contactId !== undefined) ctx.contactId = bindings.contactId
  if (bindings.companyId !== undefined) ctx.companyId = bindings.companyId

  return ctx
}
