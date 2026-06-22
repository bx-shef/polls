import { ENTITY_TYPES, type EntityType } from '../domain/schema'

/**
 * Маршрутизация «по какой сущности — какой опрос запускать» (ручные виджеты сделки/задачи и будущий
 * автотриггер). Раньше эндпоинты хардкодили `csat_postdeal` для всех — теперь ключ опроса берётся из
 * конфигурации портала (env), с дефолтом. Это позволяет, например, по задаче запускать опрос
 * удовлетворённости исполнением, а по сделке — постпродажный NPS. Чистая функция, конфиг инжектируется.
 *
 * Полноценный UI-маппинг (`entityType → surveyKey` в админке/БД) — отдельный шаг (см. `docs/issues.md`);
 * env-конфиг — первый рабочий слой без живой БД.
 */

/** Дефолтный опрос, если для сущности явная маршрутизация не задана. */
export const DEFAULT_SURVEY_KEY = 'csat_postdeal'

/** Карта «тип сущности → ключ опроса» (частичная: незаданные падают на дефолт). */
export type SurveyRouting = Partial<Record<EntityType, string>>

/**
 * Ключ опроса для сущности: из конфигурации `routing`, иначе `fallback`. Пустые/пробельные значения
 * игнорируются (как незаданные). Детерминирована, без побочных эффектов.
 */
export function surveyKeyForEntity(
  entityType: EntityType,
  routing: SurveyRouting = {},
  fallback: string = DEFAULT_SURVEY_KEY
): string {
  const k = routing[entityType]
  if (k && k.trim()) return k.trim()
  // fallback тоже обрезаем и страхуем от пустого (прямой вызов с пробельным fallback).
  return fallback.trim() || DEFAULT_SURVEY_KEY
}

/**
 * Собирает {@link SurveyRouting} из переменных окружения вида `SURVEY_KEY_<ENTITY>`
 * (`SURVEY_KEY_DEAL`, `SURVEY_KEY_TASK`, …). Неизвестные/пустые — пропускаются. Источник env
 * инжектируется (тестируемо). Дефолтный опрос задаёт `SURVEY_KEY_DEFAULT` (иначе {@link DEFAULT_SURVEY_KEY}).
 * Чистая функция; server-слой (`useSurveyRouting`) собирает её ОДИН РАЗ на процесс (конфиг статичен).
 */
export function surveyRoutingFromEnv(env: Record<string, string | undefined>): {
  routing: SurveyRouting
  fallback: string
} {
  const routing: SurveyRouting = {}
  for (const entity of ENTITY_TYPES) {
    const v = env[`SURVEY_KEY_${entity.toUpperCase()}`]
    if (v && v.trim()) routing[entity] = v.trim()
  }
  const def = env.SURVEY_KEY_DEFAULT
  return { routing, fallback: def && def.trim() ? def.trim() : DEFAULT_SURVEY_KEY }
}
