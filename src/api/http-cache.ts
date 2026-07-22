/**
 * HTTP-кэширование публичного read-эндпоинта `/api/survey/:key/current` (ISSUE #30) — чистое ядро.
 * Опубликованная версия ИММУТАБЕЛЬНА (номер не переписывается, инвариант `compile`/`publish`), поэтому
 * тройка `(surveyKey, versionNo, schemaVersion)` однозначно определяет контент публичной проекции → ETag.
 * Условный GET (`If-None-Match`) → `304 Not Modified` экономит передачу тела и клиентский парс.
 * Транспортную обвязку (заголовки/статус) ставит тонкий Nitro-роут; логика решения — здесь, под тестами.
 */

/**
 * Сильный ETag публичной версии опроса. `(surveyKey, versionNo)` задаёт иммутабельный снимок анкеты,
 * а `schemaVersion` (`SUPPORTED_SCHEMA_VERSION`) — форму публичной ПРОЕКЦИИ/конверта: если при деплое
 * сменится схема ответа БЕЗ смены `versionNo`, ETag обязан измениться (иначе клиент с `no-cache` получил
 * бы 304 и отдал устаревшее тело). Значение в кавычках по RFC 7232.
 */
export function versionETag(surveyKey: string, versionNo: number, schemaVersion: number): string {
  // encodeURIComponent: `surveyKey` по схеме без ограничения charset. Без экранирования кавычка `"`
  // в ключе даёт битый quoted-string (RFC 7232), а запятая `,` ложно расщепляется в `etagMatches`
  // (`split(',')`) → 304 молча не срабатывает. versionNo/schemaVersion — числа, безопасны.
  return `"sv-${encodeURIComponent(surveyKey)}-${versionNo}-s${schemaVersion}"`
}

/**
 * Совпадает ли наш ETag с клиентским заголовком `If-None-Match` (→ отдать `304`). Поддержка по RFC 7232:
 *  - список через запятую (`"a", "b"`);
 *  - `*` — совпадение с любым;
 *  - слабый префикс `W/` — сравниваем по opaque-значению (наш ETag сильный, но nginx при gzip конвертит
 *    его в слабый `W/…`, и клиент вернёт слабый → снимаем префикс с ОБЕИХ сторон).
 * Пустой/отсутствующий заголовок → нет совпадения (обычный `200`).
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  const want = etag.replace(/^W\//, '')
  return ifNoneMatch.split(',').some((raw) => {
    const token = raw.trim()
    return token === '*' || token.replace(/^W\//, '') === want
  })
}

/** Решение условного GET: ETag для простановки + отдавать ли `304`. */
export interface CacheDecision {
  /** ETag ответа (ставится на 200). undefined — тело некэшируемо (не 200 / не та форma). */
  etag?: string
  /** true — `If-None-Match` совпал → роут отдаёт `304` без тела. */
  notModified: boolean
}

/**
 * Чистое решение по условному GET из результата `api.survey` — вынесено из Nitro-роута под юнит-тесты
 * (проверяет «ETag только на 200 с валидной версией» + «304 лишь при совпадении», без Nitro/DOM).
 * Некэшируемо (заголовки не ставим, 304 не отдаём) на любом не-200 или неожиданной форме тела.
 */
export function cacheDecision(status: number, body: unknown, ifNoneMatch: string | undefined): CacheDecision {
  if (status !== 200) return { notModified: false }
  const b = body as { version?: { surveyKey?: unknown; versionNo?: unknown }; schema_version?: unknown }
  const v = b?.version
  if (typeof v?.surveyKey !== 'string' || typeof v.versionNo !== 'number' || typeof b.schema_version !== 'number') {
    return { notModified: false }
  }
  const etag = versionETag(v.surveyKey, v.versionNo, b.schema_version)
  return { etag, notModified: etagMatches(ifNoneMatch, etag) }
}
