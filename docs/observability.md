# Наблюдаемость (#5)

> Ядро `src/obs/` + точки интеграции (`api`, `server`, `store`). Сетевой слой
> деплоя (Pino/Sentry, reverse-proxy) — отдельно, см. «Остаётся» внизу.

Закрывает [#5](https://github.com/bx-shef/polls/issues/5): структурные логи,
`GET /api/health`, error-tracking unhandled — чтобы оператор за reverse-proxy
видел живость контейнера и мог диагностировать сбои nonce/БД/вебхуков.

## Решение: zero-dep интерфейс, адаптеры — на слое деплоя

Issue предлагал Pino/Sentry. Но конвенция репо — **«только `zod` в prod»**, а всё
ядро framework-agnostic с инъекцией зависимостей (`fetch` в OAuth, драйвер БД в
`PgStore`, часы в хендлерах). Поэтому логирование сделано тем же приёмом:

- ядро определяет **интерфейс `Logger`** и даёт **zero-dep дефолт** `createJsonLogger`;
- прод (Nuxt/Nitro) подменяет `Logger` адаптером поверх своего логгера
  (consola/pino), а `onFatal` — захватом Sentry. Ядро не пинит их версии и
  остаётся портируемым.

Это сознательный выбор: вендор-локированный логгер в ядре противоречил бы
архитектуре. Если когда-нибудь решим тащить Pino в прод — адаптер пишется в
слое деплоя без правок ядра.

## `Logger` (`src/obs/logger.ts`)

```ts
interface Logger {
  debug/info/warn/error(msg: string, fields?: LogFields): void
  child(bindings: LogFields): Logger   // request-scoped контекст
}
```

- **`createJsonLogger(opts)`** — одна строка JSON на запись: `{ level, time, msg, ...поля }`.
  Уровень из `opts.level` → env `LOG_LEVEL`/`NUXT_LOG_LEVEL` → `info`. `time`/`level`/`msg`
  зарезервированы (поля их не перетирают). Sink инжектируется (default: stdout для
  debug/info, stderr для warn/error).
- **`nullLogger`** — тишина без сайд-эффектов; default для библиотек/тестов.
- **`errInfo(e)`** — нормализация `unknown`-ошибки в `{ name, message, stack }`.

### Редакция секретов

`redact()` глубоко маскирует значения **секретных ключей** в `[REDACTED]` —
применяется к каждой записи лога автоматически. Политика:

- маскируется по **имени ключа** (подстрока, регистронезависимо):
  `token`(→ `access_token`/`refresh_token`/`portal.tokens`/`tokenKey`), `secret`
  (→ `client_secret`), `password`, `authorization`, `cookie`, `nonce`,
  `credential`, `apikey`/`api_key`, `private_key`;
- доменные идентификаторы **не трогаются**: `surveyKey`/`questionKey`/`optionKey`
  (в них есть «key», но это не секрет) — список ключей намеренно узкий;
- защита структуры: циклы → `[Circular]`, глубина > 8 → `[Truncated]`, строки
  > 10k → усечение; исходные поля не мутируются (возвращается копия).

> ⚠️ Редакция — **по ключу, не по значению**. Следствие: не кладите секреты в
> текст сообщений ошибок и строки подключения — значение под ключом
> `message`/`stack` не маскируется. Строки подключения БД задаются на слое
> деплоя (`pg.Pool`), в ядро не попадают.

## `GET /api/health`

`Api.health()` (framework-agnostic) пингует хранилище (`IStore.ping()` →
`PgStore` делает `select 1`, `MemoryStore` тривиально ок):

- живая БД → `200 { ok: true, ts }`;
- БД недоступна → `503 { ok: false, ts }` (reverse-proxy/оркестратор видит unhealthy),
  деталь ошибки — в лог (`health_ping_failed`), наружу не утекает.

Эндпоинт **публичный и НЕ throttled** (оркестратор опрашивает часто) — в
node-адаптере обрабатывается до rate-limit. Метод не GET → `405`.

## Корреляция запросов (seam под трейсы)

`server/node.ts` на каждый запрос генерирует `requestId`, отдаёт его заголовком
**`x-request-id`** и пишет строку `request` с `{ requestId, method, path, status,
durationMs, ip }` (5xx → `error`, иначе `info`). Полноценный distributed-tracing
(OTel) сюда не тянем — это лёгкая корреляция «лог ↔ клиент» без зависимостей.

## Error-tracking unhandled (`src/obs/process.ts`)

`installProcessHandlers({ logger, onFatal?, exitOnUncaught? })` вешает
`unhandledRejection` (лог, процесс не валит) и `uncaughtException` (лог +
`exit(1)` по умолчанию). **Opt-in**: модуль не трогает глобальный `process` как
сайд-эффект импорта — зовётся явно из `serve`/деплоя. `onFatal` — точка
подключения Sentry на слое деплоя.

## Где включается

`scripts/serve.ts` (демо) демонстрирует полную обвязку: `createJsonLogger` →
`createApi({ logger })` + `startServer({ logger })` + `installProcessHandlers`.
Прод-адаптер (Nitro, фаза связки) — тонкая обёртка по тому же контракту.

## Остаётся (слой деплоя)

- адаптер `Logger` поверх Pino/Nitro-логгера + `onFatal` → Sentry (живой проект);
- живой `/api/health` за reverse-proxy/TLS, проба реального `pg.Pool`;
- метрики (Prometheus) и distributed-tracing (OTel) — тянут зависимости, место
  им на слое деплоя; ядро даёт `requestId`-seam и структурные поля как основу.
