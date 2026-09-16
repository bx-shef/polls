/**
 * Runtime configuration read straight from the process environment.
 *
 * Читаем `process.env`, а не `runtimeConfig`: значения по умолчанию в `runtimeConfig`
 * вычисляются во время сборки и запекаются в образ, а строки подключения к базе и Redis
 * известны только на хосте, где контейнер запускается.
 *
 * Здесь только то, что уже читается из кода: неиспользуемая функция — это мёртвый путь,
 * который надо поддерживать, а не задел.
 */

/** Строка подключения к Postgres. Пусто — работаем без базы, `/api/health` это покажет. */
export const databaseUrl = (): string => process.env.DATABASE_URL ?? ''

/** Строка подключения к Redis. Пусто — работаем без очередей, `/api/health` это покажет. */
export const redisUrl = (): string => process.env.REDIS_URL ?? ''

export const logLevel = (): string => process.env.LOG_LEVEL ?? 'info'

/** Версия сборки: проставляется в образ, локально её нет. */
export const appVersion = (): string => process.env.APP_VERSION ?? 'dev'

/**
 * Пара приложения из партнёрского кабинета.
 *
 * `client_secret` участвует только в запросах к серверу авторизации и не должен попадать
 * в код, который выполняется в браузере, — поэтому читается здесь, на сервере, и нигде
 * не отдаётся наружу.
 */
export const b24ClientId = (): string => process.env.B24_CLIENT_ID ?? ''
export const b24ClientSecret = (): string => process.env.B24_CLIENT_SECRET ?? ''

/**
 * Адрес, от которого строятся ссылки на анкету, когда у портала не задан свой хост.
 *
 * Запасное значение, а не главное: публичный хост — поле портала (`portals.public_host`),
 * потому что клиент, договорившийся о своём домене, должен получать ссылки на нём.
 * Сюда смотрим, только когда у портала своего нет.
 */
export const publicBaseUrl = (): string => process.env.PUBLIC_BASE_URL ?? ''
