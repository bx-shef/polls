/**
 * Runtime configuration read straight from the process environment.
 *
 * Читаем `process.env`, а не `runtimeConfig`: значения по умолчанию в `runtimeConfig`
 * вычисляются во время сборки и запекаются в образ, а строки подключения к базе и Redis
 * известны только на хосте, где контейнер запускается.
 */

/** Публичный адрес, от которого строятся ссылки на анкету, если у портала не задан свой. */
export const publicBaseUrl = (): string =>
  process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? 'https://polls.bx-shef.by'

/** Строка подключения к Postgres. Пусто — работаем без базы, `/api/health` это покажет. */
export const databaseUrl = (): string => process.env.DATABASE_URL ?? ''

/** Строка подключения к Redis. Пусто — работаем без очередей, `/api/health` это покажет. */
export const redisUrl = (): string => process.env.REDIS_URL ?? ''

export const logLevel = (): string => process.env.LOG_LEVEL ?? 'info'

export const isProduction = (): boolean => process.env.NODE_ENV === 'production'

/** Версия сборки: проставляется в образ, локально её нет. */
export const appVersion = (): string => process.env.APP_VERSION ?? 'dev'
