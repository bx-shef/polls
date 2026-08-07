import type { EntityType } from '../domain/schema'

/**
 * Детекция РЕАЛЬНОГО перехода в стадию (блокер авто-триггера, #17).
 *
 * Проблема платформы: события сделки — `onCrmDealAdd`/`onCrmDealUpdate`/`onCrmDealDelete`/
 * `onCrmDealMoveToCategory`; **отдельного события смены стадии в Bitrix24 нет**, а `onCrmDealUpdate`
 * приходит на ЛЮБОЕ изменение и несёт только `ID` (без списка изменённых полей). Значит «сделка дошла
 * до стадии» из самого события не выводится: пока сделка стоит в триггерной стадии, каждое её
 * редактирование выглядело бы как повод пригласить клиента заново.
 *
 * Решение — спросить у портала историю движения по стадиям (`crm.stagehistory.list`) и убедиться, что
 * ПОСЛЕДНЕЕ, что случилось со сделкой, — это вход в нашу триггерную стадию, и случилось он ТОЛЬКО ЧТО.
 * Состояние («кого уже приглашали») при этом хранить не нужно: событие о смене стадии приходит сразу
 * после перехода и попадает в узкое окно, а любое последующее редактирование той же сделки приходит
 * позже окна — и молчит.
 *
 * ⚠️ Остаточный риск осознан: два изменения сделки ВНУТРИ одного окна дадут два приглашения. Поэтому
 * окно короткое (дефолт 60 с) и вынесено в настройки. Роботу автоматизации эта проверка не нужна —
 * он вызывается ровно на входе в стадию.
 */

/** `entityTypeId` для `crm.stagehistory.list` (см. контракт метода). */
export const STAGE_HISTORY_ENTITY_TYPE_ID: Record<Exclude<EntityType, 'spa' | 'contact' | 'company'>, number> = {
  lead: 1,
  deal: 2
}

/** Тип записи истории: 1 — создание, 2 — промежуточная стадия, 3 — финальная, 5 — смена воронки. */
export const STAGE_HISTORY_TYPE = { created: 1, intermediate: 2, final: 3, categoryChange: 5 } as const

/**
 * Запись истории стадий (нужное подмножество полей). Значения приходят из REST строками/числами —
 * типы намеренно широкие, нормализуем при разборе.
 */
export interface StageHistoryRecord {
  ID?: number | string
  TYPE_ID?: number | string
  OWNER_ID?: number | string
  CREATED_TIME?: string
  CATEGORY_ID?: number | string
  STAGE_ID?: string
}

/** Окно «переход только что» в секундах: дефолт и границы (защита от бессмысленных значений в настройках). */
export const STAGE_ENTRY_WINDOW_DEFAULT_SEC = 60
export const STAGE_ENTRY_WINDOW_MIN_SEC = 5
export const STAGE_ENTRY_WINDOW_MAX_SEC = 3600

/** Привести окно из настроек к допустимому диапазону; мусор/не-число → дефолт. */
export function resolveStageEntryWindowSec(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return STAGE_ENTRY_WINDOW_DEFAULT_SEC
  return Math.min(STAGE_ENTRY_WINDOW_MAX_SEC, Math.max(STAGE_ENTRY_WINDOW_MIN_SEC, Math.trunc(n)))
}

/** Самая свежая запись истории: по `CREATED_TIME`, при равенстве — по `ID` (монотонный). */
function latestRecord(records: readonly StageHistoryRecord[]): StageHistoryRecord | undefined {
  let best: StageHistoryRecord | undefined
  let bestTime = -Infinity
  let bestId = -Infinity
  for (const r of records) {
    const t = r.CREATED_TIME ? new Date(r.CREATED_TIME).getTime() : NaN
    if (!Number.isFinite(t)) continue // битая дата — запись в сравнении не участвует
    const id = Number(r.ID)
    const idNum = Number.isFinite(id) ? id : -Infinity
    if (t > bestTime || (t === bestTime && idNum > bestId)) {
      best = r
      bestTime = t
      bestId = idNum
    }
  }
  return best
}

export interface StageEntryCheck {
  /** Триггерная стадия опроса (формат портала: `WON` или `C1:WON`). */
  stageId: string
  /** Момент обработки события. */
  now: Date
  /** Окно «только что» в секундах (уже нормализованное `resolveStageEntryWindowSec`). */
  windowSec: number
}

/**
 * Был ли ТОЛЬКО ЧТО вход в триггерную стадию: последняя запись истории указывает на эту стадию и её
 * `CREATED_TIME` лежит в пределах окна вокруг `now` (симметрично — на случай расхождения часов портала
 * и сервера). Пустая история / битые даты / стадия не совпала / переход давний → `false`.
 *
 * **Fail-closed по смыслу:** нет доказательства свежего перехода — не приглашаем. Ошибку самого REST-вызова
 * обрабатывает вызывающий слой (тоже не приглашая) — молчание безопаснее ложной рассылки клиентам.
 */
export function isFreshStageEntry(records: readonly StageHistoryRecord[], check: StageEntryCheck): boolean {
  const last = latestRecord(records)
  if (!last || last.STAGE_ID !== check.stageId) return false
  const t = last.CREATED_TIME ? new Date(last.CREATED_TIME).getTime() : NaN
  if (!Number.isFinite(t)) return false
  const ageMs = check.now.getTime() - t
  const windowMs = check.windowSec * 1000
  return ageMs <= windowMs && ageMs >= -windowMs
}
