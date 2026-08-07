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
 * ⚠️ **Остаточный риск — дубли, и он НЕ редкий.** Проверка отвечает на вопрос «был ли переход только что»,
 * а не «приглашали ли уже». Правки сделки в реальной работе идут ГРОЗДЬЮ вокруг самого перехода:
 * менеджер тянет сделку в стадию → портал требует дозаполнить обязательные поля → сохранение (ещё один
 * `ONCRMDEALUPDATE`); автоматизация стадии дописывает свои поля тем же моментом. Каждое такое изменение
 * попадает в то же окно и даёт ЕЩЁ ОДНО приглашение — реалистично 2–4 на один переход. Длина окна тут не
 * помогает: сузишь — начнёшь терять настоящие переходы (часы портала и сервера расходятся), расширишь —
 * дублей станет больше.
 *
 * Поэтому событийный путь — «работает на любом тарифе», а НЕ «точный». Точный путь — робот автоматизации
 * (`TRIGGER_MODE=robot`): он вызывается ровно на входе в стадию, история ему не нужна. Полное лечение
 * дублей событийного пути — идемпотентность по ключу перехода: `ID` записи истории стадий уникален и
 * стабилен для одного перехода, так что «уже приглашали по переходу N» отсекает всю гроздь. Для этого
 * нужен долговечный стор приглашений (сейчас он в памяти инстанса) — вынесено в роадмап.
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

/**
 * Привести окно из настроек к допустимому диапазону; мусор/не-число/**пустая строка** → дефолт.
 * Пустая строка — штатный случай (`STAGE_ENTRY_WINDOW_SECONDS=` в `.env`): без явной проверки `Number('')`
 * даёт 0 и окно молча схлопнулось бы до минимума, то есть приглашения начали бы теряться.
 */
export function resolveStageEntryWindowSec(raw: unknown): number {
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (s === '' || s == null) return STAGE_ENTRY_WINDOW_DEFAULT_SEC
  const n = typeof s === 'string' ? Number(s) : typeof s === 'number' ? s : NaN
  if (!Number.isFinite(n)) return STAGE_ENTRY_WINDOW_DEFAULT_SEC
  return Math.min(STAGE_ENTRY_WINDOW_MAX_SEC, Math.max(STAGE_ENTRY_WINDOW_MIN_SEC, Math.trunc(n)))
}

/**
 * Самая свежая запись истории. Порядок определяем по **`ID`** (у Bitrix он монотонный и есть всегда),
 * а НЕ по дате: иначе запись с битым `CREATED_TIME` выпала бы из сравнения и «победила» бы более старая —
 * приглашение ушло бы по стадии, которую сделка уже покинула (fail-OPEN). Теперь такая запись выигрывает
 * упорядочивание и заваливает проверку свежести ниже → `false`, как и обещано.
 * Записи без числового `ID` упорядочиваются по времени (запасной путь), совсем непригодные — пропускаются.
 */
function latestRecord(records: readonly StageHistoryRecord[]): StageHistoryRecord | undefined {
  let best: StageHistoryRecord | undefined
  let bestId = -Infinity
  let bestTime = -Infinity
  for (const r of records) {
    const idRaw = Number(r.ID)
    const id = Number.isFinite(idRaw) ? idRaw : -Infinity
    const tRaw = r.CREATED_TIME ? new Date(r.CREATED_TIME).getTime() : NaN
    const t = Number.isFinite(tRaw) ? tRaw : -Infinity
    if (id === -Infinity && t === -Infinity) continue // нечем упорядочить
    if (id > bestId || (id === bestId && t > bestTime)) {
      best = r
      bestId = id
      bestTime = t
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
  return inspectStageEntry(records, check).fresh
}

/**
 * То же решение, но с наблюдёнными фактами — для ЛОГА. Без них системная поломка неотличима от штатной
 * работы: если формат `STAGE_ID` в истории разойдётся с `crm.deal.get` (префикс воронки) или часы уедут
 * дальше окна, фича вернёт `false` на 100% событий, а в логе будет ровный поток «перехода не было».
 * Наблюдённая стадия + возраст записи мгновенно показывают обе причины.
 */
export function inspectStageEntry(
  records: readonly StageHistoryRecord[],
  check: StageEntryCheck
): { fresh: boolean; observedStageId?: string; ageSec?: number } {
  const last = latestRecord(records)
  if (!last) return { fresh: false }
  const t = last.CREATED_TIME ? new Date(last.CREATED_TIME).getTime() : NaN
  const observedStageId = last.STAGE_ID
  if (!Number.isFinite(t)) return { fresh: false, observedStageId }
  const ageMs = check.now.getTime() - t
  const ageSec = Math.round(ageMs / 1000)
  if (observedStageId !== check.stageId) return { fresh: false, observedStageId, ageSec }
  const windowMs = check.windowSec * 1000
  return { fresh: ageMs <= windowMs && ageMs >= -windowMs, observedStageId, ageSec }
}
