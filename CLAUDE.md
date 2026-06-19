# CLAUDE.md

Ядро сервиса опросов (движок + версионирование + аналитика) под будущую
интеграцию с Bitrix24. В репозитории — **ядро + framework-agnostic HTTP-слой**
(TypeScript): хендлеры `/api/session`+`/api/submit` с анти-абьюзом и node-адаптер
(`pnpm serve`). Nuxt/b24ui-фронт и Nitro-привязка — фаза связки. Комментарии и
документация — на русском. Канонический источник спецификации — `docs/brief.md`
(§1 — что и зачем); рабочий процесс задача→PR→review→мерж — ниже.

## Текущее состояние (одним взглядом)

| Слой | Что | Статус |
|---|---|---|
| `domain/` | схема/метрики/ответы/компиляция/агрегация | ✅ готово, под тестами |
| `store/` | `IStore` + `MemoryStore` + `PgStore` (PostgreSQL) | ✅ готово, под тестами |
| `api/` | `createApi` + анти-абьюз (nonce/ratelimit/invitation) | ✅ готово, под тестами |
| `obs/` | логгер/health/process-хуки | ✅ готово, под тестами |
| `bitrix24/` | crypto/oauth/portal (OAuth-токены) | ✅ ядро готово, под тестами |
| `server/node.ts` | node:http-адаптер (`pnpm serve`) | ✅ готово |
| `client/` | `SurveyFill` — «мозг» прохождения опроса (контур A, без DOM) | ✅ готово, под тестами (#24) |
| Визуальный гейт | Playwright скриншот-регрессия + Stop-хук (#13) | ✅ на живом `/s/:key` (webServer; #39, `docs/visual-gate.md`) |
| `app/` (Nuxt 4 + b24ui) | каркас приложения контура A (`nuxt.config.ts`, `app.vue`, заглушка-маршрут) | ✅ каркас собирается/рендерит; экраны ⏳ |
| `server/` (Nitro) | обёртки `createApi`: `/api/` session · submit · survey/:key/current · health | ✅ привязка готова (dev-стор MemoryStore+seed) |
| Фронт-экраны (контур A) | Интро/Опрос/Спасибо (`/s/:key`, `useSurvey` поверх `SurveyFill` + `/api/*`) | 🔶 happy-path + гейт intro/survey/thanks/error ×(light+dark) + persist/deep-link ✅; загрузка/пусто → #34 |
| Дашборд (контур B) | аналитика внутри Bitrix24 | ⏳ не начат |
| Деплой-слой | Docker/TLS/мульти-инстанс | ⏳ не начат (#4/#5/#6/#17) |

Карта фаз и зависимостей — `docs/roadmap.md`; карта issue — `docs/issues.md`.

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
pnpm migrate up   # применить миграции БД (node-pg-migrate; DATABASE_URL). Создать: pnpm migrate create
pnpm dev          # Nuxt-приложение контура A (app/) в dev-режиме (HMR)
pnpm build        # сборка Nuxt (.output); pnpm preview — превью собранного
pnpm test:visual  # визуальный гейт #13: скриншот-регрессия (Playwright). Обновить эталоны:
                  # pnpm test:visual:update (после глазами-сверки). Браузер: pnpm visual:install.
                  # НЕ входит в `pnpm check` — запускается Stop-хуком Claude Code при
                  # завершении сессии на изменениях UI. См. docs/visual-gate.md
```

Для проверок предпочитай `scripts/check.sh` / `check.ps1` — один запуск ставит
зависимости и прогоняет всё, отдавая готовый результат.

## Архитектура (`src/`)

- `domain/schema.ts` — **единый источник истины** типов и валидации (zod). Enum'ы
  (`QUESTION_TYPES`, `METRICS`) и составные структуры (`CompiledVersion`,
  `ResponseRecord`, `CrmContext`, `StoredAnswer`) выводятся из zod-схем — TS-тип и
  runtime-валидация не расходятся. Даты — `z.string().datetime()` (ISO-8601).
  Презентация (`intro`/`thanks`/`blocks`, #25) вшита в draft/version (version-frozen) —
  контент экранов для Vue-слоя из снимка анкеты, не второй источник правды.
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
  SQL-агрегация (`aggregateNps/Csat/Distribution/NpsTrend`) с принудительным подавлением малых N
  на чувствительных срезах; durable-идемпотентность `addResponse` по `invitation_token`
  (`ON CONFLICT DO NOTHING`); тесты на pglite (in-process, паритет с in-memory).
  `store/cursor.ts` — helpers keyset-курсора (encode/decode/compare).
- `api/handlers.ts` (`createApi`) — framework-agnostic HTTP-хендлеры (вход → {status, body},
  зависимости инжектируются). `survey({surveyKey})` (GET `/api/survey/:key/current`, #25) отдаёт
  текущую версию для рендера контура A — публичная проекция БЕЗ `invitationPolicy` (внутренняя
  CRM-конфигурация наружу не утекает), rate-limited, 404 если опроса нет. Конвейер
  submit = honeypot → rate-limit → форма/schema_version →
  nonce (409 replay / 403 unknown) → версия (404) → валидация ответов (422) → приглашение
  (#3: токен → снимок CrmContext, single-use; replay 409 / unknown 403 / чужой пин 409) →
  запись с СЕРВЕРНЫМИ id/submittedAt; context — снимок из приглашения либо пустой без токена.
  `api/nonce.ts` (`MemoryNonceStore`, TTL), `api/ratelimit.ts` (`SlidingWindowLimiter`) и
  `api/invitation.ts` (`MemoryInvitationStore`, single-use) — in-memory анти-абьюз/состояние
  одного инстанса. `server/node.ts` — адаптер на node:http (лимит тела 413,
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
- `client/survey-fill.ts` (`SurveyFill`) — framework-agnostic «мозг» прохождения опроса
  (контур A): навигация/deep-link, валидация шага, single/multi + exclusive, «Другое»,
  persist-снимок (safeParse недоверенного restore), маппинг в `Submission`. Без DOM/Vue —
  Vue-композабл фазы связки оборачивает реактивностью (каркас Vue-слоя — ниже, `## Приложение`);
  визуальный гейт — #13.

## Приложение (`app/`, Nuxt 4 + b24ui)

Каркас контура A. Ядро остаётся в `src/` и Nuxt'ом НЕ сканируется: `nuxt.config.ts`
(корень) задаёт `srcDir: 'app/'`, модуль `@bitrix24/b24ui-nuxt` (Tailwind/air-токены
внутри модуля), алиас `~core → src/` для доступа к типам/функциям ядра без дублирования
логики. **CSS-вход обязателен:** `app/assets/css/main.css` (`@import "tailwindcss"` +
`@import "@bitrix24/b24ui-nuxt"`) подключён через `css: [...]` — без него ни air-токены
компонентов, ни Tailwind-утилиты не компилируются (deps: `tailwindcss`). `app/app.vue` —
`B24App` (обёртка темы) + `NuxtPage`; `app/pages/index.vue` — заглушка-маршрут на штатных
`B24Card`/`B24Badge`/`B24Button` (рендерит b24ui, подтверждает сборку И стилизацию). Ядровой `pnpm check` независим
(root tsconfig типизирует только `src/test/scripts`; Nuxt — своим tsconfig, генерится
`postinstall: nuxt prepare`; CI-typecheck `app/` — отдельным шагом с экранами, ISSUE
[#36](https://github.com/bx-shef/polls/issues/36)).

**Граница `~core` (важно для безопасности):** из клиентских `.vue`/composables импортируем
ТОЛЬКО `~core/client` и `~core/domain` (чистая логика без секретов). `~core/bitrix24`,
`~core/store`, `~core/api`, `~core/obs` — **server-only** (Nitro-роуты в `server/`): иначе
крипто/токены/SQL попадут в клиентский бандл. Серверный слой — корневой `server/` (в Nuxt 4
`serverDir` по умолчанию `<rootDir>/server`, доп. конфиг не нужен).

**Nitro-привязка ядра (`server/`):** тонкие обёртки над `createApi` — `server/utils/api.ts`
(`useApi()`, инстанс на процесс: пока MemoryStore+seed для dev-паритета с `pnpm serve`;
прод-стор/PgStore + общий анти-абьюз — слой деплоя #4/#6) + роуты `server/api/`:
`GET /api/session`, `POST /api/submit`, `GET /api/survey/:key/current`, `GET /api/health`.
Логика — в ядре, обёртки только мапят `event → api.*(...)`/статус (+ body-limit 64КБ на
submit, паритет с `node.ts`; невалидный JSON отвергает h3 — формат h3, не ядровой). Типизируются
Nitro-tsconfig, не ядровым `pnpm check` (CI-typecheck server/app → #36); живой smoke — `pnpm build` + curl.

**Экраны контура A (`app/pages/s/[key].vue` + `app/components/survey/*`):** маршрут `/s/:key`
оркеструет фазы intro→survey→thanks через композабл `app/composables/useSurvey.ts` — тонкую
реактивную обёртку (`shallowRef`+bump-тик, решение в `decisions.md`) над ядровым `SurveyFill`;
вся логика прохождения остаётся в ядре, экраны эмитят намерения и зовут публичные `/api/*`.
Версию грузит страница через `useAsyncData` (SSR-payload + рефетч при смене `:key`), отдаёт в
композабл через `reset()`. Клиентский тип версии — `PublicVersion` (`Omit<…,'invitationPolicy'>`,
чувствительное поле не попадает в бандл/рендер). Презентация (`intro`/`thanks`) — из снимка
(#25; демо-контент в `demo/seed.ts`). Вопросы — `B24RadioGroup`/`B24CheckboxGroup` (`variant=card`)/`B24Textarea`.

Маршрут привязан к визуальному гейту (#39: `webServer`+`baseURL`, гейт снимает живой `/s/:key`).
**Persist + deep-link (#34):** прогресс кладётся в localStorage (`SurveyFill.snapshot()`), `hydrate()`
в `onMounted` страницы восстанавливает его (resume на reload) и поддерживает `?q=N` (1-based);
снимок чистится на успешном submit; restore недоверенный — валидируется ядром. Только клиент
(localStorage нет на SSR) → гейт на fresh-контексте видит интро.
Тёмная тема (#34): `@nuxtjs/color-mode` (preference system, classSuffix '' → класс `.dark`) флипает
b24ui по `prefers-color-scheme`; гейт детерминированно гоняет ОБЕ темы через colorScheme-проекты.
Визуальный гейт: 4 поверхности (intro/survey/thanks/error=404) × 3 брейкпоинта × 2 темы = 24 эталона.
Дальше (#34): состояния загрузка/пусто/submit-ошибка.

## Инварианты

- Стабильные `question_key` / `option_key` — якоря сопоставимости между версиями.
- Опубликованная версия иммутабельна (`publish` запрещает перезапись номера).
- Валидация на границах: `compile()` парсит черновик, `addResponse()` — запись.
- Подавление малых выборок (`ANONYMITY_THRESHOLD`/`meetsAnonymity`), пагинация и
  tenant-изоляция (`portalId`) — ответственность слоя чтения/PgStore, не «сырых»
  агрегатов. `test/template.test.ts` стережёт валидность шаблона относительно схемы.

## Конвенции

- TS strict + `noUncheckedIndexedAccess` — доступ по индексу даёт `T | undefined`.
- Зависимости — по делу, без догмы «zero-dep»: берём проверенные библиотеки, где они
  оправданы. Прод-ядро держим лёгким (валидация — `zod`); инфраструктуру не изобретаем
  (миграции — `node-pg-migrate`). dev: vitest/tsx/typescript/pglite.
- Каждое нетривиальное решение фиксируется в `docs/`.

## Рабочий процесс (задача → PR → review → мерж)

- **Ветка** `claude/<slug>` от свежего `main`; одна задача — одна ветка.
- **Скоуп PR маленький:** один слой/контур за раз. «Не в скоуп» → выносим в ISSUE.
- **Тело PR** (без модельного идентификатора): «простыми словами» → «что внутри» →
  «проверка» (`pnpm check` зелёный) → «дальше».
- **Ревью-ритуал:** 5 Sonnet-агентов в фоне (документалист / программист /
  тестировщик / security / CTO; каждый держится **диффа** — проект большой, иначе
  таймаут) + `/review`. Сводный отчёт с severity **blocker / major / minor / nit**.
- **Правки** — в тот же PR; после них — снова `pnpm check`.
- **Гейт мержа:** `pnpm check` зелёный (typecheck + тесты с покрытием ≥85%, по факту
  ~100% + `verify`), CI success, clean working tree, 0 отставания от `main` (иначе sync).
- **Мерж:** squash + курированное тело + штампы → удалить ветку. Roadmap-issue
  остаётся открытым (закрывается, когда закрыт весь скоуп фазы).
- **Решения** фиксируются в `docs/` (индекс — `docs/decisions.md`).

## Definition of Done (по слоям)

- **Ядро (`src/`):** типы прошли `pnpm typecheck`; тесты зелёные с покрытием ≥85%
  (по факту ~100%); `pnpm verify` сверяет агрегаты на 4 уровнях; нетривиальные
  решения записаны в `docs/`.
- **UI (контуры A/B):** визуальная верификация (рендер → скриншот → сверка с
  `docs/design.md` → починка состояний/брейкпоинтов); детерминированный гейт — #13.
- **Интеграция Bitrix24:** живой smoke связки (`scripts/b24-smoke.ts`), маппинг
  CRM→`CrmContext` сверен на реальном портале (mock-данные в CI, не живой портал).
- **North-star:** рабочий сервис опросов в связке с Bitrix24 (датчик → AI → KPI/Лента).

## Визуальная верификация UI (с фазы связки)

Вступает в силу с Nuxt/b24ui-слоя (фронта в ядре пока нет). **ВАЖНО:** правка
UI/CSS не готова, пока не увидена глазами — рендер → скриншот → сверка с макетом →
починка (брейкпоинты, состояния пусто/ошибка, hover/focus/disabled, тёмная тема).
**Приватность:** скриншоты живого портала (CRM/домены/токены) не коммитим, не шлём
в облачный чат, не кладём в CI — только dev/staging с мок-данными. Детерминированный
гейт (Playwright + `Stop`-хук, #13/#39) — **на живых маршрутах**: `webServer` поднимает
собранное приложение, `pnpm test:visual` снимает реальный SSR-рендер `/s/:key` (3 брейкпоинта)
на детерминированном сиде. `.claude/hooks/visual-gate.sh` гейтит на изменениях UI. Детали и
порядок добавления экрана — `docs/visual-gate.md`.

## Скоуп и роадмап

Сетевой/деплой-слой вынесен в ISSUE (не дефекты ядра):
- **#3** (закрыт) — OAuth Bitrix24: ядро в `src/bitrix24` (AES-256-GCM шифрование
  `portal.tokens`, refresh-flow, startup-guard ключа). Invitation-flow: ядро-рантайм
  сделан (`Invitation` + `api/invitation.ts` + проброс в submit; маппинг сверен вживую,
  см. `docs/bitrix24-integration.md`); `invitationPolicy` вшита в схему/версию (уровень —
  version-frozen, решение **#21**); `triggerStages` денормализованы + `IStore.surveysTriggeredBy`
  (GIN, **#22**) — сделано. Остаётся binding `ONCRMDEALUPDATE` — **#17** (он нормализует
  `stageId` под формат `triggerStages`); идемпотентность/общий стор — **#4**.
- **#4** — анти-абьюз: ядро сделано в `src/api` (server-set `submittedAt`, nonce TTL → 409,
  honeypot → 400, rate-limit → 429, идемпотентность по invitation — single-use, #3).
  Durable-идемпотентность записи: `response.invitation_token` + частичный UNIQUE
  (миграция 0003) — повтор приглашения на ЛЮБОМ инстансе → `ON CONFLICT DO NOTHING`
  (MemoryStore дублирует семантику Set'ом). Остаётся: общий стор nonce/лимитов/приглашений
  для мульти-инстанса, серверная конфигурация за reverse-proxy.
- **#5** — наблюдаемость: ядро сделано (`src/obs`: zero-dep структурный логгер с редакцией
  секретов, `GET /api/health` → 200/503, `installProcessHandlers` для unhandled, `x-request-id`).
  Остаётся (слой деплоя): адаптеры `Logger`→Pino / `onFatal`→Sentry, живой `/health` за
  reverse-proxy, метрики/OTel-трейсы. См. `docs/observability.md`.
- **#6** — раннер миграций: `node-pg-migrate` поверх `migrations/*.sql` (`pnpm migrate up`);
  те же `.sql` применяют pglite-тесты (единый источник схемы), initdb-механизм убран.
  Осталось: живой прогон на Postgres (деплой). Первая `0002_*` (денормализация
  `triggerStages` под binding) — сделана (#22); `invitationPolicy` миграции не требует (JSONB).
- **read-API / PgStore** — сделаны: CRUD + tenant-изоляция, keyset-пагинация,
  SQL-агрегация с принудительным подавлением малых N, денормализация, транзакции,
  идемпотентный ensure (#7 закрыт). Публичный read контура A — `GET /api/survey/:key/current`
  (`survey()`, проекция без `invitationPolicy`, #25) — сделан. Идемпотентность `addResponse`
  (durable по invitation_token, миграция 0003) и SQL-`npsTrend` (`aggregateNpsTrend`,
  паритет с in-memory) — сделаны. Осталось: связь `response.invitation_id` с общим стором
  приглашений (#4) и PII-редакция на HTTP-слое (нет публичного read-ответов — ISSUE
  [#31](https://github.com/bx-shef/polls/issues/31)); кэш/ETag для read-эндпоинтов —
  ISSUE [#30](https://github.com/bx-shef/polls/issues/30).

## Документация (`docs/`)

`brief.md` (спецификация), `design.md` (b24ui), `data-model.md` (PostgreSQL + аналитика),
`observability.md` (логи/health/error-tracking — #5),
`bitrix24-integration.md` (маппинг CRM→`CrmContext` + smoke-тест связки `scripts/b24-smoke.ts`),
`roadmap.md` (карта фаз: где мы → фронт → дашборд → деплой),
`visual-gate.md` (детерминированный визуальный гейт #13: Playwright + Stop-хук),
`issues.md` (карта открытых issue: статус/зависимости),
`glossary.md` (термины: контур A/B, версия-снимок, `question_key`, invitation/CrmContext, exclusive, малые N, `portalId`),
`decisions.md` (индекс решений — короткое «почему так»),
`reference/survey-schema.template.json` (обезличенный шаблон — валидный `SurveyDraft`).

## Среда (web-сессии)

SessionStart-хук настроен: `.claude/hooks/session-start.sh` (зарегистрирован в
`.claude/settings.json`) ставит зависимости (`pnpm install --frozen-lockfile`) при
старте веб-сессии Claude Code, чтобы typecheck/test/verify работали сразу.
Запускается синхронно и только в удалённой среде (гард по `CLAUDE_CODE_REMOTE`);
локально — мгновенный выход. Вступает в силу для всех сессий после мержа в
дефолтную ветку.

Stop-хук визуального гейта: `.claude/hooks/visual-gate.sh` (#13) — на завершении сессии,
если тронуты UI-поверхности, прогоняет скриншот-регрессию (`pnpm test:visual`) и блокирует
остановку при расхождении с эталоном. Узкий триггер (чистое ядро не трогает), мягкая
деградация без браузера. Детали — `docs/visual-gate.md`.

---
*Последнее ревью: 2026-06-19.*
