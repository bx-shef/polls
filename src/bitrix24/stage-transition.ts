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
 * (`TRIGGER_MODE=robot`): он вызывается ровно на входе в стадию, история ему не нужна.
 *
 * **Ключ перехода отсюда — основа лечения дублей** (#138). `ID` записи истории уникален и стабилен для
 * одного перехода, поэтому ВСЯ гроздь событий вокруг него видит одно и то же значение. Признаком «по
 * этому переходу уже приглашали» служит НЕ запись в нашей базе, а дело в таймлайне сделки на стороне
 * портала: оно и так создаётся доставкой (#126), видно человеку и переживает что угодно на нашей стороне.
 * Ключ едет в маркер дела (`ORIGIN_ID`), по нему же дело и ищется перед созданием. Порядок работ и
 * оговорки — `docs/process.md`, шаг 5.
 *
 * Окно «только что» при этом остаётся: оно отвечает на ДРУГОЙ вопрос — «был ли переход вообще». Без него
 * приглашение уходило бы на каждое редактирование сделки, стоящей в триггерной стадии месяцами.
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
 * приглашение ушло бы по стадии, которую сделка уже покинула (fail-OPEN).
 *
 * **Непригодная запись выигрывает упорядочивание намеренно.** И при битом `CREATED_TIME`, и при
 * отсутствующем/нечисловом `ID` мы НЕ можем доказать, что запись не самая свежая, — поэтому даём ей
 * победить и заваливаем проверку свежести ниже (`false`). Иначе получался бы тот же fail-OPEN с другого
 * конца: запись без `ID` получала бы минимальный ранг, побеждала бы более старая запись с `ID`, и
 * приглашение ушло бы по уже покинутой стадии. Ценой этого мы иногда промолчим — что и обещано:
 * молчание дешевле ложной рассылки клиентам.
 */
function latestRecord(records: readonly StageHistoryRecord[]): StageHistoryRecord | undefined {
  let best: StageHistoryRecord | undefined
  let bestId = -Infinity
  let bestTime = -Infinity
  for (const r of records) {
    const idRaw = Number(r.ID)
    // Нечитаемый ID → +Infinity: такая запись побеждает и проваливает проверку свежести (fail-closed).
    const id = r.ID != null && Number.isFinite(idRaw) ? idRaw : Infinity
    const tRaw = r.CREATED_TIME ? new Date(r.CREATED_TIME).getTime() : NaN
    const t = Number.isFinite(tRaw) ? tRaw : -Infinity
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
): { fresh: boolean; observedStageId?: string; ageSec?: number; transitionId?: string } {
  const last = latestRecord(records)
  if (!last) return { fresh: false }
  const t = last.CREATED_TIME ? new Date(last.CREATED_TIME).getTime() : NaN
  const observedStageId = last.STAGE_ID
  const transitionId = readTransitionId(last)
  if (!Number.isFinite(t)) return { fresh: false, observedStageId, transitionId }
  const ageMs = check.now.getTime() - t
  const ageSec = Math.round(ageMs / 1000)
  if (observedStageId !== check.stageId) return { fresh: false, observedStageId, ageSec, transitionId }
  const windowMs = check.windowSec * 1000
  return { fresh: ageMs <= windowMs && ageMs >= -windowMs, observedStageId, ageSec, transitionId }
}

/**
 * `ID` записи истории как КЛЮЧ ИДЕМПОТЕНТНОСТИ перехода (#138) — строкой, канонично.
 *
 * Почему именно он: запись истории заводится один раз на переход, её `ID` уникален и больше не
 * меняется. Вся гроздь событий вокруг перехода (дозаполнение полей, автоматизация стадии) читает ту же
 * историю и видит ту же запись — значит и ключ у них один. Ни `dealId + stageId` (сделка может вернуться
 * в ту же стадию — это НОВЫЙ повод спросить клиента), ни время (у каждого события своё) так не умеют.
 *
 * Канонизация обязательна: REST отдаёт `ID` то числом, то строкой, и `'42'` против `42` — это два
 * разных ключа, то есть дедуп, который молча не работает. Нечисловое/отсутствующее → `undefined`:
 * выдуманный ключ хуже отсутствующего — он отсечёт чужой переход.
 */
function readTransitionId(record: StageHistoryRecord): string | undefined {
  const raw = record.ID
  if (raw == null) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? String(n) : undefined
}
