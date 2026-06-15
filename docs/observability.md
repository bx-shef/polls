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
  // сокращённо — в коде 4 отдельных метода (полный интерфейс в src/obs/logger.ts)
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
  (→ `client_secret`), `password`/`passwd`, `authorization`, `cookie`, `signature`
  (вебхуки B24), `nonce`, `credential`, `apikey`/`api_key`, `privatekey`/`private_key`;
- доменные идентификаторы **не трогаются**: `surveyKey`/`questionKey`/`optionKey`
  (в них есть «key», но это не секрет) — список ключей намеренно узкий;
- защита структуры: циклы → `[Circular]`, глубина > 8 → `[Truncated]`, строки
  > 10k → усечение; исходные поля не мутируются (возвращается копия).

> ⚠️ Редакция — **по ключу, не по значению**. Следствие: общие секреты в тексте
> сообщений ошибок (`message`/`stack`) не маскируются. Частное исключение — креды
> в строках подключения (`scheme://user:pass@host`, типичная утечка pg/redis при
> сбое соединения): их вычищает `errInfo`. Тем не менее не полагайтесь на это —
> не кладите секреты в сообщения исключений.

## `GET /api/health`

`Api.health()` (framework-agnostic) пингует хранилище (`IStore.ping()` →
`PgStore` делает `select 1`, `MemoryStore` тривиально ок):

- живая БД → `200 { ok: true, ts }`;
- БД недоступна → `503 { ok: false, ts }` (reverse-proxy/оркестратор видит unhealthy),
  деталь ошибки — в лог (`health_ping_failed`), наружу не утекает.

Эндпоинт **публичный и НЕ throttled** (оркестратор опрашивает часто) — в
node-адаптере обрабатывается до rate-limit. Метод не GET → `405`. Результат пинга
кэшируется на `healthCacheMs` (default 1000 мс), чтобы флуд `/api/health` не долбил
пул БД (анти-DoS); за reverse-proxy полезно дополнительно ограничить частоту на прокси.

## Корреляция запросов (seam под трейсы)

`server/node.ts` на каждый запрос генерирует `requestId`, отдаёт его заголовком
**`x-request-id`** и пишет строку `request` с `{ requestId, method, path, status,
durationMs, ip }`. Уровень: `5xx → error`, `4xx → warn` (видны всплески 429/422),
иначе `info`. `durationMs` — от приёма запроса до `res.end()` (не до доставки
клиенту). Полноценный distributed-tracing (OTel) сюда не тянем — это лёгкая
корреляция «лог ↔ клиент» без зависимостей.

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
- **политика `ip` в логах**: `ip` в строке `request` — PII (за reverse-proxy это
  X-Forwarded-For — реальный IP пользователя); слой деплоя обязан решить —
  хэшировать / опускать / зафиксировать правовое основание и retention;
- метрики (Prometheus) и distributed-tracing (OTel) — тянут зависимости, место
  им на слое деплоя; ядро даёт `requestId`-seam и структурные поля как основу.

---
*Последнее ревью: 2026-06-15.*
