/**
 * Runtime configuration read straight from the process environment.
 *
 * Читаем `process.env`, а не `runtimeConfig`: значения по умолчанию в `runtimeConfig`
 * вычисляются во время сборки и запекаются в образ, а строки подключения к базе и Redis
 * известны только на хосте, где контейнер запускается.
 *
 * Здесь только то, что уже читается из кода. `PUBLIC_BASE_URL` появится вместе
 * с генерацией ссылок: неиспользуемая функция — это мёртвый путь, который надо
 * поддерживать, а не задел.
 */

/** Строка подключения к Postgres. Пусто — работаем без базы, `/api/health` это покажет. */
export const databaseUrl = (): string => process.env.DATABASE_URL ?? ''

/** Строка подключения к Redis. Пусто — работаем без очередей, `/api/health` это покажет. */
export const redisUrl = (): string => process.env.REDIS_URL ?? ''

export const logLevel = (): string => process.env.LOG_LEVEL ?? 'info'

/** Версия сборки: проставляется в образ, локально её нет. */
export const appVersion = (): string => process.env.APP_VERSION ?? 'dev'
