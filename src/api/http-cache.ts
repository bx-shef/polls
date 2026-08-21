/**
 * HTTP-кэширование публичного read-эндпоинта `/api/survey/:key/current` (ISSUE #30) — чистое ядро.
 * Опубликованная версия ИММУТАБЕЛЬНА (номер не переписывается, инвариант `compile`/`publish`), поэтому
 * четвёрка `(portalId, surveyKey, versionNo, schemaVersion)` однозначно определяет контент публичной
 * проекции → ETag. Портал в ключе — с мультитенанта (#49): ключ опроса уникален в пределах портала,
 * а не глобально.
 * Условный GET (`If-None-Match`) → `304 Not Modified` экономит передачу тела и клиентский парс.
 * Транспортную обвязку (заголовки/статус) ставит тонкий Nitro-роут; логика решения — здесь, под тестами.
 */

/**
 * Сильный ETag публичной версии опроса. `(surveyKey, versionNo)` задаёт иммутабельный снимок анкеты,
 * а `schemaVersion` (`SUPPORTED_SCHEMA_VERSION`) — форму публичной ПРОЕКЦИИ/конверта: если при деплое
 * сменится схема ответа БЕЗ смены `versionNo`, ETag обязан измениться (иначе клиент с `no-cache` получил
 * бы 304 и отдал устаревшее тело). Значение в кавычках по RFC 7232.
 */
export function versionETag(
  surveyKey: string,
  versionNo: number,
  schemaVersion: number,
  portalId: number | undefined
): string {
  // encodeURIComponent: `surveyKey` по схеме без ограничения charset. Без экранирования кавычка `"`
  // в ключе даёт битый quoted-string (RFC 7232), а запятая `,` ложно расщепляется в `etagMatches`
  // (`split(',')`) → 304 молча не срабатывает. versionNo/schemaVersion — числа, безопасны.
  //
  // ⚠️ Портал — ЧАСТЬ ключа (#49). Уникальность ключа опроса в схеме — `(group_id, survey_key)`, то
  // есть `csat_postdeal` заводит себе каждый портал, и без этой части один и тот же ETag обозначал бы
  // РАЗНЫЕ анкеты. Адрес `/api/survey/:key/current` у них при этом общий — значит и в кэше браузера
  // они лежат под одним ключом: респондент, открывший подряд ссылки двух заказчиков, получал бы на
  // второй 304 и видел анкету первого. Тихо и правдоподобно: страница рисуется, вопросы «какие-то есть».
  // ⚠️ Дефис в ключе ЭКРАНИРУЕМ. `encodeURIComponent` его не трогает, а он у нас разделитель сегментов:
  // без экранирования `versionETag('p7-x', 2, 1, undefined)` и `versionETag('x', 2, 1, 7)` дают одну и
  // ту же строку — то есть портал в ключе перестаёт разделять ровно в том случае, ради которого его
  // туда и положили.
  const key = encodeURIComponent(surveyKey).replace(/-/g, '%2D')
  const tenant = portalId === undefined ? '' : `-p${portalId}`
  return `"sv${tenant}-${key}-${versionNo}-s${schemaVersion}"`
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
export function cacheDecision(
  status: number,
  body: unknown,
  ifNoneMatch: string | undefined,
  // ⚠️ Обязательный, хоть и допускающий `undefined`: забытый аргумент у второго вызывающего молча
  // вернул бы ETag без тенанта — ровно тот дефект, ради которого поле и заведено.
  portalId: number | undefined
): CacheDecision {
  if (status !== 200) return { notModified: false }
  const b = body as { version?: { surveyKey?: unknown; versionNo?: unknown }; schema_version?: unknown }
  const v = b?.version
  if (typeof v?.surveyKey !== 'string' || typeof v.versionNo !== 'number' || typeof b.schema_version !== 'number') {
    return { notModified: false }
  }
  const etag = versionETag(v.surveyKey, v.versionNo, b.schema_version, portalId)
  return { etag, notModified: etagMatches(ifNoneMatch, etag) }
}
