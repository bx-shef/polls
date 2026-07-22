/**
 * HTTP-кэширование публичного read-эндпоинта `/api/survey/:key/current` (ISSUE #30) — чистое ядро.
 * Опубликованная версия ИММУТАБЕЛЬНА (номер не переписывается, инвариант `compile`/`publish`), поэтому
 * пара `(surveyKey, versionNo)` однозначно определяет контент публичной проекции → идеальный ETag.
 * Условный GET (`If-None-Match`) → `304 Not Modified` экономит передачу тела и клиентский парс.
 * Транспортную обвязку (заголовки/статус) ставит тонкий Nitro-роут; логика сравнения — здесь, под тестами.
 */

/**
 * Сильный ETag публичной версии опроса. `(surveyKey, versionNo)` детерминированно задаёт иммутабельный
 * снимок — версия не меняется после публикации, поэтому ETag стабилен до СМЕНЫ текущей версии (publish
 * новой → другой `versionNo` → другой ETag). Значение в кавычках по RFC 7232.
 */
export function versionETag(surveyKey: string, versionNo: number): string {
  return `"sv-${surveyKey}-${versionNo}"`
}

/**
 * Совпадает ли наш ETag с клиентским заголовком `If-None-Match` (→ отдать `304`). Поддержка по RFC 7232:
 *  - список через запятую (`"a", "b"`);
 *  - `*` — совпадение с любым;
 *  - слабый префикс `W/` — сравниваем по opaque-значению (наш ETag сильный, но клиент мог вернуть `W/`).
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
