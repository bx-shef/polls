# CLAUDE.md

Сервис опросов для Bitrix24 (движок + версионирование + аналитика): **framework-agnostic ядро**
(`src/`, TypeScript) + **Nuxt 4/b24ui-приложение** (контур A `/s/:key` + дашборд контура B `/d/:key`
+ admin `/admin/*`) + **Nitro-привязка** (`server/`). Развёрнут вживую (`polls.bx-shef.by`, TLS,
авто-CD merge→GHCR→watchtower; прод-`docker-compose.prod.yml` разводит PostgreSQL — app идёт на PgStore
при заданном `DATABASE_URL`). **Live-verified — read-путь** (вебхук); **install/handshake ждут живого
smoke** (код готов). Комментарии и документация — на русском.

> **Единый источник правды по проекту — [`docs/project-map.md`](docs/project-map.md)** (архитектура,
> данные, интеграция Bitrix24, деплой/эксплуатация, безопасность, ключевые решения, статус
> «что сделано / что проверить», дальнейшая работа, глоссарий). Как работает сервис и как управлять
> опросами — [`docs/process.md`](docs/process.md). Открытые задачи — [`docs/issues.md`](docs/issues.md).
> Обезличенный шаблон схемы — [`docs/reference/survey-schema.template.json`](docs/reference/survey-schema.template.json).
>
> Этот файл (`CLAUDE.md`) — **операционные правила для агента**: команды, границы, инварианты,
> конвенции, рабочий процесс. Архитектурные детали НЕ дублируем — они в карте проекта.

## Команды

```bash
pnpm check        # всё разом: typecheck + test (с покрытием) + verify
bash scripts/check.sh                                   # то же, Linux/macOS, с pnpm install
powershell -ExecutionPolicy Bypass -File scripts\check.ps1   # то же, Windows
pnpm typecheck    # tsc --noEmit (ядро)
pnpm test         # vitest;  pnpm test:cov — с покрытием (порог 85% в vitest.config.ts; CI гейтит).
                  # pg-тесты на pglite (WASM-Postgres) — небыстрые (~10–30с), это норма
pnpm verify       # печатает И сверяет assert'ами итог на 4 уровнях (src/demo/seed.ts)
pnpm check:boundary  # гард границы ~core (#36): клиент app/** не тянет server-only ядро (отд. шаг CI)
pnpm typecheck:app   # vue-tsc app/+server/ (Nuxt; отд. шаг CI). Перед — pnpm nuxt:prepare
pnpm serve        # демо HTTP-сервер на MemoryStore+seed (PORT=8080)
pnpm migrate up   # применить миграции БД (node-pg-migrate; DATABASE_URL). Создать: pnpm migrate create
pnpm dev          # Nuxt-приложение в dev (HMR);  pnpm build / pnpm preview
pnpm test:visual  # визуальный гейт: скриншот-регрессия (Playwright). Обновить эталоны:
                  # pnpm test:visual:update (после глазами-сверки). Браузер: pnpm visual:install.
                  # НЕ входит в `pnpm check` — запускается Stop-хуком при завершении сессии на изменениях UI.
```

Для проверок предпочитай `scripts/check.sh` / `check.ps1` — один запуск ставит зависимости и прогоняет всё.

## Граница `~core` (важно для безопасности)

Ядро (`src/`) framework-agnostic, Nuxt его НЕ сканирует (`srcDir: 'app/'`, алиас `~core → src/`).
Из клиентских `.vue`/composables импортируем **ТОЛЬКО** `~core/client` и `~core/domain` (чистая логика
без секретов). `~core/{bitrix24,store,api,obs}` — **server-only** (Nitro-роуты `server/`): иначе крипто/
токены/SQL попадут в клиентский бандл. Форсится в CI: `pnpm check:boundary` (проваливает шаг, если
`app/**` тянет server-only сегмент или обходит альяс прямым путём в `src/{bitrix24,store,api,obs}`).
Типы `app/`+`server/` гейтит `pnpm typecheck:app` (vue-tsc); ядровой `pnpm typecheck` независим.

## Инварианты

- Стабильные `question_key` / `option_key` — якоря сопоставимости между версиями.
- Опубликованная версия иммутабельна (`publish` запрещает перезапись номера); ответ пинится на версию.
- Валидация на границах: `compile()` парсит черновик, `addResponse()` — запись.
- Подавление малых выборок (`ANONYMITY_THRESHOLD = 5` / `meetsAnonymity`), пагинация и tenant-изоляция
  (`portalId`) — ответственность слоя чтения/PgStore, не «сырых» агрегатов.
- Секреты не логируем (`redact` по имени ключа); токены портала шифруются (AES-256-GCM);
  входящие события/установку верифицируем (constant-time `application_token`, member_id-binding,
  SSRF-allowlist домена). Детали — карта проекта, §Безопасность.

## Конвенции

- TS strict + `noUncheckedIndexedAccess` — доступ по индексу даёт `T | undefined`.
- Зависимости — по делу, без догмы «zero-dep»: проверенные библиотеки где оправданы. Прод-ядро лёгкое
  (валидация — `zod`); инфру не изобретаем (миграции — `node-pg-migrate`). dev: vitest/tsx/typescript/pglite.
- **Каждое нетривиальное решение фиксируется в `docs/project-map.md` (§Ключевые решения).**
- Комментарии/JSDoc и пользовательский текст — на русском.

## Рабочий процесс (задача → PR → review → мерж)

- **Ветка** `claude/<slug>` от свежего `main`; одна задача — одна ветка. Скоуп PR маленький (один слой/
  контур за раз); «не в скоуп» → выносим в ISSUE.
- **Тело PR** (без модельного идентификатора): «простыми словами» → «что внутри» → «проверка»
  (`pnpm check` зелёный) → «дальше».
- **Ревью-ритуал:** 5 агентов в фоне (документалист / программист / тестировщик / security / CTO;
  каждый держится **диффа** — проект большой, иначе таймаут) + сводный отчёт с severity
  **blocker / major / minor / nit**. Правки — в тот же PR, после них снова `pnpm check`.
- **Гейт мержа:** `pnpm check` зелёный (typecheck + тесты с покрытием ≥85%, по факту ~100% + `verify`),
  CI success, clean working tree, 0 отставания от `main` (иначе sync).
- **Мерж:** squash + курированное тело + штампы → удалить ветку. Roadmap-issue остаётся открытым
  (закрывается, когда закрыт весь скоуп фазы).

## Definition of Done (по слоям)

- **Ядро (`src/`):** `pnpm typecheck` + тесты с покрытием ≥85% (по факту ~100%) + `pnpm verify`
  (агрегаты на 4 уровнях); нетривиальные решения записаны в карту проекта.
- **UI (контуры A/B):** визуальная верификация (рендер → скриншот → сверка с макетом → починка
  состояний/брейкпоинтов); детерминированный гейт — ниже.
- **Интеграция Bitrix24:** живой smoke связки (`scripts/b24-smoke.ts`), маппинг CRM→`CrmContext` сверен
  на реальном портале (mock-данные в CI, не живой портал).
- **North-star:** рабочий сервис опросов в связке с Bitrix24 (датчик → AI → KPI/Лента).

## Визуальная верификация UI

**ВАЖНО:** правка UI/CSS не готова, пока не увидена глазами — рендер → скриншот → сверка с макетом →
починка (брейкпоинты, состояния пусто/ошибка, hover/focus/disabled, тёмная тема). **Приватность:**
скриншоты живого портала (CRM/домены/токены) не коммитим, не шлём в облачный чат, не кладём в CI —
только dev/staging с мок-данными. Детерминированный гейт (Playwright + `Stop`-хук) — на живых маршрутах:
`webServer` поднимает собранное приложение, `pnpm test:visual` снимает реальный SSR-рендер (48 эталонов).
`.claude/hooks/visual-gate.sh` гейтит на изменениях UI. Порядок добавления экрана и детали — карта
проекта, §Визуальный гейт.

## Среда (web-сессии)

- **SessionStart-хук** `.claude/hooks/session-start.sh` (в `.claude/settings.json`) ставит зависимости
  (`pnpm install --frozen-lockfile`) при старте веб-сессии — чтобы typecheck/test/verify работали сразу.
  Синхронно, только в удалённой среде (гард `CLAUDE_CODE_REMOTE`); локально — мгновенный выход.
- **Stop-хук визуального гейта** `.claude/hooks/visual-gate.sh` — на завершении сессии, если тронуты
  UI-поверхности, прогоняет `pnpm test:visual` и блокирует остановку при расхождении. Узкий триггер
  (чистое ядро/docs/миграции не трогает), мягкая деградация без браузера.

## CI и зависимости

GitHub Actions: `ci.yml` (typecheck ядра + граница `~core` + `typecheck:app` vue-tsc + тесты с покрытием
+ verify), `docker-build.yml` (сборка прод-образа на PR — **без публикации**, гейт от поломки образа до
мержа), `docker-publish.yml` (публикация в GHCR на push в `main`/теги). `.github/dependabot.yml` —
авто-обновления npm/actions/docker с группировкой (мажор `nuxt`/`@bitrix24/*` — отдельным PR; major
`node` заигнорен под corepack). Авто-мерж Dependabot НЕ включён (мержит владелец). Сторонние actions
запиннены на полный commit-SHA (supply-chain; Dependabot `github-actions` обновляет SHA сам).

## Reporting Kit (вендорный бандл `reporting-kit/`)

Переносимый набор отчётности из базы знаний (`bx-shef/ai-agent`): навыки `/report-status`,
`/report-digest`, `/report-questions` (готовят текст отчёта; отправляет `scripts/tg-send.sh` только по
явной команде). Лежит **как есть** самодостаточным каталогом (упрощает синхронизацию с источником).

- **Не линтуется** нашими проверками; `.github/workflows/` бандла GitHub не запускает (активны только
  workflow в корневом `.github/`) — kit инертен.
- **Навыки kit** Claude Code подхватывает автоматически, но они **scoped** к каталогу `reporting-kit/`.
- **Секреты Telegram** (`TG_BOT_TOKEN`/`TG_CHAT_ID`) — только в окружении, не в git.

## Версии стека Bitrix24

`@bitrix24/b24jssdk ^2.0` (наш тонкий слой `src/bitrix24/client.ts` на не-deprecated
`actions.v2.call.make`; breaking changes 2.0 касаются v3-роутинга, не нашего пути) и
`@bitrix24/b24ui-nuxt ^2.9`. Базовый шаблон приложения — [`bitrix24/templates-dashboard`](https://github.com/bitrix24/templates-dashboard).

---
*Последнее ревью: 2026-07-24. Полная карта проекта — [`docs/project-map.md`](docs/project-map.md).*
