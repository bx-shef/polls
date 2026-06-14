# CLAUDE.md

Ядро сервиса опросов (движок + версионирование + аналитика) под будущую
интеграцию с Bitrix24. В репозитории — **ядро + framework-agnostic HTTP-слой**
(TypeScript): хендлеры `/api/session`+`/api/submit` с анти-абьюзом и node-адаптер
(`pnpm serve`). Nuxt/b24ui-фронт и Nitro-привязка — фаза связки. Комментарии и
документация — на русском.

## Команды

```bash
pnpm check        # всё разом: typecheck + test (с покрытием) + verify
bash scripts/check.sh                                   # то же, Linux/macOS, с pnpm install
powershell -ExecutionPolicy Bypass -File scripts\check.ps1   # то же, Windows
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm test:cov     # vitest + покрытие (пороги 85% в vitest.config.ts; CI гейтит этим).
                  # pg-тесты на pglite (WASM-Postgres) — небыстрые (~10–30с), это норма
pnpm verify       # печатает И сверяет assert'ами итог на 4 уровнях (src/demo/seed.ts)
pnpm serve        # демо HTTP-сервер на MemoryStore+seed (PORT=8080): /api/session, /api/submit
```

Для проверок предпочитай `scripts/check.sh` / `check.ps1` — один запуск ставит
зависимости и прогоняет всё, отдавая готовый результат.

## Архитектура (`src/`)

- `domain/schema.ts` — **единый источник истины** типов и валидации (zod). Enum'ы
  (`QUESTION_TYPES`, `METRICS`) и составные структуры (`CompiledVersion`,
  `ResponseRecord`, `CrmContext`, `StoredAnswer`) выводятся из zod-схем — TS-тип и
  runtime-валидация не расходятся. Даты — `z.string().datetime()` (ISO-8601).
- `domain/metrics.ts` — чистые детерминированные метрики (nps/csat/ces/distribution).
- `domain/answers.ts` — серверная нормализация/валидация ответов (устойчива к подделке ключей).
- `domain/compile.ts` — компиляция черновика в иммутабельную версию + `diffVersions`
  (классы изменений; сопоставимость ряда по стабильному `question_key`).
- `domain/aggregate.ts` — агрегация на 4 уровнях (опрос/услуга/клиент/направление) + KPI/тренд;
  срезы по версии (`byVersion`/`byVersionRange`), `npsTrend(minN)`.
- `store/types.ts` (`IStore`) + `store/memory.ts` (`MemoryStore`) — контракт хранилища
  (методы async, вкл. keyset-пагинацию `listResponsesPage`) и in-memory реализация.
  `store/pg.ts` (`PgStore`) — реализация поверх PostgreSQL: драйвер-агностичная
  (`Queryable` ≈ `pg.Pool`/pglite; запись в транзакции при поддержке драйвера),
  tenant-scoped по `portalId`; денормализация контекста в колонки + `response_product`;
  SQL-агрегация (`aggregateNps/Csat/Distribution`) с принудительным подавлением малых N
  на чувствительных срезах; тесты на pglite (in-process, паритет с in-memory).
  `store/cursor.ts` — helpers keyset-курсора (encode/decode/compare).
- `api/handlers.ts` (`createApi`) — framework-agnostic HTTP-хендлеры (вход → {status, body},
  зависимости инжектируются): конвейер submit = honeypot → rate-limit → форма/schema_version →
  nonce (409 replay / 403 unknown) → версия (404) → валидация ответов (422) → запись с
  СЕРВЕРНЫМИ id/submittedAt и пустым context (до invitation-flow #3). `api/nonce.ts`
  (`MemoryNonceStore`, TTL) и `api/ratelimit.ts` (`SlidingWindowLimiter`) — in-memory
  анти-абьюз одного инстанса. `server/node.ts` — адаптер на node:http (лимит тела 413,
  JSON 400, роутинг, `x-request-id` + строка лога `request`); Nitro-обёртка фазы связки — пример в JSDoc handlers.
- `obs/logger.ts` (`Logger`/`createJsonLogger` + `redact` секретов) и `obs/process.ts`
  (`installProcessHandlers`: unhandled → лог + `onFatal`/Sentry) — наблюдаемость (#5), zero-dep.
  `GET /api/health` = `Api.health()` → `IStore.ping()` (200/503). Прод подменяет `Logger`
  адаптером (Pino/Sentry) инъекцией. Детали — `docs/observability.md`.
- `bitrix24/crypto.ts` (`TokenCipher` AES-256-GCM с `kid` в blob — форвард-совместимость
  ротации ключа + `loadTokenKey` startup-guard),
  `bitrix24/oauth.ts` (`Bitrix24OAuth` — обмен кода/refresh POST-телом через инжектируемый fetch),
  `bitrix24/portal.ts` (`PortalTokenStore` — зашифрованное хранение `portal.tokens` + авто-refresh).
- `demo/seed.ts` — детерминированный демо-набор (общий для `verify` и тестов).

## Инварианты

- Стабильные `question_key` / `option_key` — якоря сопоставимости между версиями.
- Опубликованная версия иммутабельна (`publish` запрещает перезапись номера).
- Валидация на границах: `compile()` парсит черновик, `addResponse()` — запись.
- Подавление малых выборок (`ANONYMITY_THRESHOLD`/`meetsAnonymity`), пагинация и
  tenant-изоляция (`portalId`) — ответственность слоя чтения/PgStore, не «сырых»
  агрегатов. `test/template.test.ts` стережёт валидность шаблона относительно схемы.

## Конвенции

- TS strict + `noUncheckedIndexedAccess` — доступ по индексу даёт `T | undefined`.
- Без лишних зависимостей: только `zod` в prod (+ dev: vitest/tsx/typescript/pglite).
- Каждое нетривиальное решение фиксируется в `docs/`.

## Визуальная верификация UI (с фазы связки)

Вступает в силу с Nuxt/b24ui-слоя (фронта в ядре пока нет). **ВАЖНО:** правка
UI/CSS не готова, пока не увидена глазами — рендер → скриншот → сверка с макетом →
починка (брейкпоинты, состояния пусто/ошибка, hover/focus/disabled, тёмная тема).
**Приватность:** скриншоты живого портала (CRM/домены/токены) не коммитим, не шлём
в облачный чат, не кладём в CI — только dev/staging с мок-данными. Детерминированный
гейт (Playwright + `Stop`-хук) — issue #13.

## Скоуп и роадмап

Сетевой/деплой-слой вынесен в ISSUE (не дефекты ядра):
- **#3** — OAuth Bitrix24: ядро в `src/bitrix24` (AES-256-GCM шифрование `portal.tokens`,
  refresh-flow, startup-guard ключа). Остаётся: install/callback-эндпоинт + живой обмен с порталом.
- **#4** — анти-абьюз: ядро сделано в `src/api` (server-set `submittedAt`, nonce TTL → 409,
  honeypot → 400, rate-limit → 429). Остаётся: идемпотентность по invitation (с #3),
  общий стор nonce/лимитов для мульти-инстанса, серверная конфигурация за reverse-proxy.
- **#5** — наблюдаемость: ядро сделано (`src/obs`: zero-dep структурный логгер с редакцией
  секретов, `GET /api/health` → 200/503, `installProcessHandlers` для unhandled, `x-request-id`).
  Остаётся (слой деплоя): адаптеры `Logger`→Pino / `onFatal`→Sentry, живой `/health` за
  reverse-proxy, метрики/OTel-трейсы. См. `docs/observability.md`.
- **#6** — раннер миграций (`0002+`).
- **read-API / PgStore** — сделаны: CRUD + tenant-изоляция, keyset-пагинация,
  SQL-агрегация с принудительным подавлением малых N, денормализация, транзакции,
  идемпотентный ensure (#7 закрыт). Осталось: идемпотентность `addResponse` (с #4),
  PII-редакция на HTTP-слое и SQL-вариант `npsTrend` (ISSUE [#10](https://github.com/bx-shef/polls/issues/10)).

## Документация (`docs/`)

`brief.md` (спецификация), `design.md` (b24ui), `data-model.md` (PostgreSQL + аналитика),
`observability.md` (логи/health/error-tracking — #5),
`reference/survey-schema.template.json` (обезличенный шаблон — валидный `SurveyDraft`).

## Среда (web-сессии)

SessionStart-хук настроен: `.claude/hooks/session-start.sh` (зарегистрирован в
`.claude/settings.json`) ставит зависимости (`pnpm install --frozen-lockfile`) при
старте веб-сессии Claude Code, чтобы typecheck/test/verify работали сразу.
Запускается синхронно и только в удалённой среде (гард по `CLAUDE_CODE_REMOTE`);
локально — мгновенный выход. Вступает в силу для всех сессий после мержа в
дефолтную ветку.

---
*Последнее ревью: 2026-06-14.*
