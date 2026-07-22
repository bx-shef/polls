# План улучшения репозитория polls

> Сравнительный анализ **polls** (сервис опросов) с образцом **procure-ai**
> (`bx-shef/ai-price-import` — AI-импорт документов в Bitrix24) и план переноса
> зрелых инфраструктурных/lifecycle/продуктовых паттернов. Стек у обоих один:
> Nuxt 4 + Nitro (`node-server`) + PostgreSQL + `@bitrix24/b24jssdk`, мультитенант
> по `member_id`. Документ дополняет [`roadmap.md`](./roadmap.md) (карта фаз) и
> [`issues.md`](./issues.md) (карта задач) — здесь **что взять у соседа и зачем**.

## 0. Как читать этот документ

Приоритеты: 🔴 критично (почти-баг: потеря данных/токенов, cross-tenant, требование
Маркета) · 🟠 высокий · 🟡 средний · 🟢 низкий/по мере роста.

Каждый пункт: **Проблема → Донор (файлы-образцы) → В polls (что трогать) →
Миграция/env → Приоритет**. Пути донора — от корня `ai-price-import/`; пути polls —
от корня репозитория.

**Главный вывод.** polls **уже живой** (`polls.bx-shef.by`, TLS, PostgreSQL,
авто-CD merge→GHCR→watchtower, установка на портал работает) и имеет **более чистую**
базовую архитектуру, чем донор (framework-agnostic ядро в `src/` + тонкие Nitro-обёртки
в `server/`, граница форсится `check:boundary`). Поэтому это **эволюция**, а не стройка,
и перенос ложится естественно: чистые куски → `src/bitrix24/*` (ядро), живые
обёртки → `server/`. Но у polls есть **латентные почти-баги в OAuth-lifecycle**, которые
надо закрыть в первую очередь — они опаснее любой новой фичи (раздел 2).

---

## 1. Что уже есть в polls (чтобы не строить заново)

| Слой | Состояние |
|---|---|
| Деплой | ✅ Docker + GHCR + Watchtower + общий `nginx-proxy` + acme (Let's Encrypt) + PostgreSQL; `Makefile` (`prod-up`/`redeploy`/`logs`); живой `polls.bx-shef.by` |
| CI | ✅ `ci.yml` (typecheck ядра + граница `~core` + `typecheck:app` vue-tsc + тесты с покрытием ≥85% + `verify`); `docker-build.yml` (PR-гейт образа без публикации); `docker-publish.yml` (GHCR на push в main/теги); экшены запиннены на SHA; Dependabot |
| Наблюдаемость | ✅ ядро `src/obs`: zero-dep JSON-логгер с редакцией секретов + `child()`, `GET /api/health` (200/503), process-хуки. ❌ трейсов/метрик/истории нет |
| OAuth Bitrix24 | ✅ `PortalTokenStore` (шифрование AES-256-GCM `portal.tokens` + refresh), `resolveMemberIdByDomain`, frame-handshake `POST /api/b24/session` со **сверкой member_id** (`bitrix24/frame.ts`), установка `/api/b24/install` (робот + плейсменты) |
| Анти-абьюз | ✅ nonce TTL / rate-limit / honeypot / invitation single-use — **in-memory, один инстанс** (#4); durable-идемпотентность ответа (миграция 0003) |
| Сессии/авторизация | ✅ HMAC-SHA256 подписанная сессия (`src/api/session.ts`), `requirePortalSession`, fail-closed `DASHBOARD_AUTH_SECRET`, `isStrongSecret` |
| Отчётность | ✅ `reporting-kit/` вендорен (навыки `/report-*`, отправка в Telegram по явной команде) — это **отчёты оператора**, НЕ пользовательская обратная связь |

**Чего нет вовсе:** обработки `ONAPPUNINSTALL`, тумбстоуна портала, привязки `member_id`
к гранту, keep-alive рефреша, advisory-lock рефреша, OpenTelemetry, очередей/Redis,
edge-security паритета, деплоя в «чёрную дыру», рейтинга приложения, in-app виджета
обратной связи, операторской консоли, ESLint, каталогов `server/plugins`/`server/middleware`.

**Стратегическая развилка.** Важность разделов 2/7/8 зависит от того, идёт ли polls в
**Маркет как мультитенант** (много порталов) или остаётся **локальным приложением на портал**
(в схеме сейчас `portal` — «обычно одна строка»). `roadmap.md` указывает на мультитенант
(«tenant-изоляция дашборда при нескольких порталах», #47/#49), поэтому план исходит из
**мультитенанта**. Но два пункта раздела 2 (uninstall + keep-alive) критичны при **любом**
сценарии.

---

## 2. 🔴 Устойчивость OAuth-lifecycle — почти-баги (делать первым)

Это не фичи, а корректность/безопасность/комплаенс. Все пункты доменно-нейтральны и
переносятся из донора почти дословно. Ложатся на существующий `src/bitrix24/portal.ts`
+ одну миграцию.

### 2.1 🔴 Обработка `ONAPPUNINSTALL` + удаление данных портала

- **Проблема.** polls обрабатывает установку (`/api/b24/install`), но **не** удаление.
  При удалении приложения из портала его токены и данные остаются в БД навсегда — это
  и требование Маркета (data-policy), и утечка PII (имена клиентов/ответственных в
  `response.context`/`invitation`), и мусор.
- **Донор.** `server/api/b24/events.post.ts` (единый вебхук install+uninstall),
  `server/utils/b24EventsHandler.ts` (`decideB24Event` — чистый вердикт + `safeEqual`
  constant-time), `app/utils/b24Events.ts` (`parseBracketForm` PHP-bracket-form с гардом
  от prototype-pollution + `extractEvent`), `server/utils/tokenStore.ts` (`deletePortal`).
  Ключевая модель доверия B24: `application_token` **не пре-шаренный секрет** — он
  доставляется в первом `ONAPPINSTALL` и запоминается; это единственный способ
  аутентифицировать `ONAPPUNINSTALL` (у него нет иных данных).
- **В polls.** (а) захватить и сохранить `application_token` при установке (сейчас #17
  помечает это как TODO) — колонка `portal.application_token` (write-once через
  `COALESCE(NULLIF(...))`); (б) чистое ядро `src/bitrix24/events.ts` — порт `decideB24Event`
  (у polls уже есть `verifyApplicationToken` constant-time в `deal-event.ts` — переиспользовать);
  (в) `parseBracketForm`/`extractEvent` в `src/bitrix24/` (чистые, тестируемые);
  (г) `PortalTokenStore.deletePortal(memberId, ts)` — ✅ **сделано** (0004): тумбстоун + удаление
  данных портала транзакцией в порядке зависимостей (FK на `portal(id)` — **без** `on delete cascade`;
  каскад есть только `response`→answer/product/insight, поэтому чистим вручную); (д) роут
  `server/api/b24/events.post.ts` (или
  расширить `install.post.ts` веткой `ONAPPUNINSTALL`).
- **Миграция/env.** `0004`: `portal.application_token text`. Без нового env.
- **Приоритет.** 🔴 — комплаенс Маркета + PII. Блокирует 2.2.

### 2.2 🔴 Тумбстоун портала + `UPDATE-only` персист рефреша

- **Проблема.** Два независимых способа «воскресить» удалённый портал:
  (1) `PortalTokenStore.save` — это **upsert** (`insert … on conflict (member_id) do update`),
  поэтому запоздавший/переигранный `ONAPPINSTALL` **после** uninstall пересоздаст портал
  устаревшими кредами; (2) тот же upsert на пути рефреша (`accessToken → save(refreshed)`)
  воскресит только что удалённый портал. B24 доставляет online-события **без гарантии
  порядка** и может ретраить — гонка реальна.
- **Донор.** `server/db/schema.ts` (таблица `portal_tombstone (member_id PK, deleted_ts BIGINT)`),
  `server/utils/tokenStore.ts`: `deletePortal` пишет тумбстоун **до** чистки (с `GREATEST` при
  повторной доставке); `saveToken` при `eventTs>0` сперва `SELECT 1 FROM portal_tombstone WHERE
  member_id=$1 AND deleted_ts>=$2` → если такой-или-новее uninstall был, register — no-op;
  настоящая переустановка (строго новее) чистит устаревший тумбстоун. `updateTokensOnRefresh`
  — **UPDATE-only** (никогда INSERT): исчезла строка под uninstall → UPDATE матчит 0 строк →
  портал остаётся удалён (сама пропавшая строка — гард). `server/utils/retentionSweep.ts`
  (`sweepExpired` + `resolveTombstoneDays`), `server/plugins/retention.ts` (ежечасный sweep).
  Корректность TOCTOU-free при **одном** писателе событий (single-instance).
- **В polls.** (а) `PortalTokenStore`: **разделить** `save` на `saveOnInstall` (upsert с
  тумбстоун-гардом по `eventTs` = top-level `ts` вебхука) и `updateOnRefresh` (UPDATE-only);
  (б) `deletePortal` пишет тумбстоун; (в) `src/store/` sweep-хелпер + ежечасный запуск
  (см. keep-alive 2.4 — один и тот же таймер-инстанс).
- **Миграция/env.** `0004`: таблица `portal_tombstone`. `TOMBSTONE_TTL_DAYS` (дефолт 30,
  кламп `[1,365]`).
- **Приоритет.** 🔴 (комплект с 2.1).

### 2.3 🟠 Привязка `member_id` к OAuth-гранту (анти install-poisoning)

- **Проблема.** `member_id` в первом `ONAPPINSTALL` — **клиент-контролируемое** поле.
  Владелец любого реального портала A может подделать install с чужим `member_id` +
  валидным токеном портала A → отравит tenant-ключ жертвы (targeted cross-tenant DoS).
  polls уже делает сверку `member_id` для **frame-handshake** (`bitrix24/frame.ts`), но,
  вероятно, **не** для install-события.
- **Донор.** `server/utils/verifyInstallToken.ts` (доказать контроль **домена** дешёвым
  authed-вызовом `profile`) + `server/utils/verifyInstallMember.ts` (`rawOauthRefresh` —
  рефрешнуть доставленный `refresh_token`; токен-эндпоинт вернёт **authoritative** `member_id`,
  который обязан совпасть с заявленным). Fail-closed: mismatch/`invalid_grant` → 403;
  сеть/config → 503; пустой member_id → 503. Рефреш **ротирует** ⇒ хранится возвращённый
  грант, не присланные креды. Классификация по машинному коду (`isAuthRejection`), не по тексту.
  Осознанное **единственное исключение** из «всё через SDK»: сырой POST на фиксированный
  `oauth.bitrix.info/oauth/token/`, т.к. SDK-рефреш выбрасывает `member_id` из ответа
  (хост фиксирован → нет SSRF, секреты в теле POST, `AbortSignal.timeout`).
- **В polls.** Чистые `verifyInstallToken`/`verifyInstallMember` в `src/bitrix24/`
  (у polls уже есть `Bitrix24OAuth` обмен/refresh — DI-инъекция); вызвать в install-конвейере
  **до** `handleInstall`. Гейт на `NUXT_B24_CLIENT_ID/SECRET`.
- **Приоритет.** 🟠 (security-critical; важность растёт с числом порталов).

### 2.4 🔴 Keep-alive рефреш токенов (иначе idle-порталы мрут на 180-й день)

- **Проблема.** B24 `refresh_token` живёт ~180 дней. polls рефрешит **только по требованию**
  (`accessToken()` при REST-вызове; фоновой ротации нет). Портал, где опросы неактивны
  неделями (типичный кейс для survey-приложения!), **не делает вызовов** — его
  `refresh_token` молча умирает на 180-й день, портал потерян до переустановки.
  **Это гарантированная потеря простаивающих порталов.**
- **Донор.** `server/utils/tokenKeepAlive.ts` (`runTokenKeepAlive`, `selectTokensNearExpiry`,
  `nearExpiryCutoffMs`, `keepAliveIntervalMs`), `server/utils/accessToken.ts`
  (`REFRESH_TTL_DAYS=180`, `needsProactiveRefresh`). Суточный крон рефрешит **только**
  порталы в ~3-дневной полосе у истечения (`updated_at` старше `now-(180-3)д`, но не старше
  полного TTL — нижняя граница отсекает уже мёртвые гранты). Батч-кап 50. Per-portal ошибки
  изолированы. Намеренно консервативно (частый рефреш → риск авто-блока приложения B24).
- **В polls.** (а) добавить `portal.updated_at` (штамповать на install и refresh);
  (б) чистые `selectTokensNearExpiry`/`nearExpiryCutoffMs`/`keepAliveIntervalMs` в `src/store/`
  или `src/bitrix24/`; (в) запуск: `server/plugins/keepalive.ts` — `setInterval(runKeepAlive,
  keepAliveIntervalMs(TOKEN_KEEPALIVE_HOURS))` (polls сейчас single-instance → один процесс;
  при мульти-инстансе гейт на cron-роли, см. раздел 6).
- **Миграция/env.** `0004`: `portal.updated_at timestamptz not null default now()`.
  `TOKEN_KEEPALIVE_HOURS` (дефолт 24, кламп `[1h,168h]` — **верхний кламп критичен**: иначе
  переполнение `setInterval` 2³¹мс → Node схлопывает в 1мс → tight-loop).
- **Приоритет.** 🔴 — латентная потеря данных.

### 2.5 🟡 Сериализация рефреша per-portal (advisory-lock) — при scale-out

- **Проблема.** При мульти-инстансе два процесса, рефрешащие один портал, гоняются на
  **ротации** refresh-токена — проигравший навсегда ломает рефреш портала. polls сейчас
  single-instance, но keep-alive-крон + REST-путь могут пересечься уже сейчас.
- **Донор.** `server/utils/dbLock.ts` (`withAdvisoryLock` = `pg_advisory_xact_lock`,
  авто-релиз на COMMIT), `server/utils/ensureAccessToken.ts` (`ensureFreshToken`:
  lock → **re-read** свежайшего токена → рефреш ровно один; `lock_timeout=10s`,
  `statement_timeout=20s`, `READ COMMITTED`). Кнопка reauth (`portalReauth.ts`)
  переиспользует ту же цепочку.
- **В polls.** Немедленно — только **UPDATE-only persist** (уже нужен для 2.2, закрывает
  воскрешение). Полный advisory-lock — при вводе второго инстанса (раздел 6). `withAdvisoryLock`
  — ~30 строк, самодостаточен, `Queryable`-совместим с драйвер-агностичным `PgStore`.
- **Приоритет.** 🟡 (UPDATE-only — сразу с 2.2; лок — при мульти-инстансе).

> **Итог раздела 2 — одна миграция + один таймер.** `0004_portal_lifecycle.sql`:
> `portal.application_token`, `portal.updated_at`, таблица `portal_tombstone`
> (+ `portal_app_rating` из раздела 7, если делаем). Один `server/plugins/lifecycle.ts`
> ведёт и keep-alive, и tombstone-sweep (оба — редкие таймеры). Всё остальное — чистые
> функции в `src/`, под тесты (паритет с pglite, как весь `PgStore`).

---

## 3. 🟠 Деплой (усиление того, что уже работает)

polls уже на хорошей модели (общий `nginx-proxy` + watchtower + GHCR). Донор добавляет
несколько приёмов «anti-drift / fail-fast / изоляция», которые стоит взять точечно.

- **Сетевая изоляция БД — обязательно.** Донор: `dbnet` (и `queuenet`) объявлены
  `internal: true` — Postgres/Redis физически недоступны из интернета, наружу смотрит только
  прокси. У polls `db-net` **не** `internal` (см. `docker-compose.prod.yml`). Правка — одна
  строка, снижает поверхность атаки. 🟠
- **Fail-fast HEALTHCHECK без лишних бинарей.** Донор: `NODE_OPTIONS= node -e
  "fetch('http://127.0.0.1:3000/api/health')…"` (сбрасывает `NODE_OPTIONS`, чтобы будущий
  OTel-preload не тормозил пробу). У polls есть `/api/health`, но нет `HEALTHCHECK` в
  `Dockerfile`. Добавить. 🟡
- **Anti-drift пароля БД.** Донор собирает `DATABASE_URL` из `POSTGRES_*` прямо в
  `environment:` — пароль не разъезжается между `app` и `db`. polls в `prod.yml` уже так
  делает (`postgres://polls:${POSTGRES_PASSWORD}@db`) — ✅, оставить.
- **Green-CI → deploy gate.** Донор: `deploy.yml` триггерится `workflow_run` после зелёного
  CI и держит явный `verify-ci` gate. polls публикует образ по `push:[main]` **параллельно**
  CI (`docker-publish.yml`) — образ может уехать в GHCR даже если `ci.yml` красный. Добавить
  зависимость публикации от зелёного CI (через `workflow_run` или `needs`). 🟠
- **Двухобразная топология (nginx `app` + Nitro `backend`) — НЕ обязательна.** Донор
  разделяет ради отдельного CSP/rate-limit слоя. polls за общим `nginx-proxy` уже получает
  TLS; отдельный per-app nginx имеет смысл только если нужен свой CSP для контура B с PII —
  но это дешевле закрыть edge-security в приложении (3.1). **Рекомендация: остаться на одном
  образе.** (См. раздел 12 — что не тащить.)

### 3.1 🟠 Edge-security паритет без nginx

- **Проблема.** Голый Nitro не даёт того, что даёт nginx: security-заголовки/CSP/HSTS,
  `limit_req` на логине, `client_max_body_size`. Критично, потому что (а) контур B отдаёт
  **PII** (имена клиентов/ответственных), (б) появляется auth-гейт `/api/b24/session` +
  operator-логин (разделы 2/9), (в) деплой в «чёрную дыру» (раздел 4) идёт **вообще без
  nginx**.
- **Донор.** `server/utils/edgeSecurity.ts` (чистое ядро, DI на env, unit-тесты) +
  `server/middleware/edgeSecurity.ts` (глобальная Nitro-middleware). Гейт за
  `APP_EDGE_SECURITY` (дефолт off — за nginx НЕ ставить, иначе двойной CSP ломает страницу).
  `edgeBodyGuard` (глобально: `Content-Length>лимит` → 413; chunked без длины → 411 **до**
  чтения тела → анти-OOM), CSP байт-в-байт с `nginx.conf` (константы `PAGE_CSP`/`FORM_CSP`,
  «no drift»), HSTS, `nosniff`, `Referrer-Policy`; `X-Frame-Options` намеренно НЕ ставят
  (ограничивает `frame-ancestors https://*.bitrix24.*` для iframe). Анти-брутфорс логина
  (`LOGIN_MAX_ATTEMPTS=10`/`15мин`), ключ лимита = `socket.remoteAddress` (реальный пир, не
  подделать) с escape-hatch `APP_EDGE_TRUST_XFF` для доверенного тоннеля.
- **В polls.** `src/**` (чистое ядро — polls-конвенция) `edge-security.ts` +
  `server/middleware/edge-security.ts`. CSP адаптировать под b24ui (контур A — indigo-тема +
  inline `__NUXT__` → `script-src 'unsafe-inline'`; `frame-ancestors *.bitrix24.*`). Повесить
  анти-брутфорс на `/api/b24/session` и operator-логин. Даже за nginx паттерн «CSP как общая
  константа» полезен.
- **Env.** `APP_EDGE_SECURITY` (1/true), `APP_EDGE_TRUST_XFF` (для тоннеля «чёрной дыры»).
- **Приоритет.** 🟠 (обязателен для раздела 4; ценен для контура B независимо).

---

## 4. 🟡 Деплой в «чёрную дыру» (Bitrix Vibecode Black Hole)

- **Что это.** Альтернативный таргет: закрытая Bitrix-Cloud VM без SSH, управляемая только
  по REST (`vibecode.bitrix24.tech/v1`). Всё приложение — **один Nitro-процесс на :3000**
  (лендинг/страницы + `/api/*` + фоновые задачи + миграции на старте). Полезно как
  «canonical Bitrix-hosting» и запасной путь деплоя.
- **Донор.** `deploy/vibecode-deploy.sh` (идемпотентный REST-деплой: найти сервер по
  `APP_NAME` → создать если нет → ждать `CONNECTED` → `accessPolicy=PUBLIC` → deploy;
  тело — из `ENV_JSON`, источник — публичный `codeload.github.com/.../<sha>.tar.gz`),
  `.github/workflows/deploy-vibecode.yml` (**opt-in**: `if: vars.VIBECODE_DEPLOY == 'true'`
  — мерж workflow не запускает деплой и не красит CI, пока владелец не выставит переменную;
  секреты `VIBE_KEY`/`APP_ENV_JSON`), `docs/DEPLOY_VIBECODE.md`.
- **В polls — проще, чем у донора.** У polls нет OCR/LLM/claude-code CLI, значит `PRESTART_CMD`
  сворачивается до `apt-get install postgresql` (Redis — только если введём общий стор
  анти-абьюза, раздел 6; сейчас анти-абьюз in-memory → single-container **без Redis**). Единый
  Nitro-процесс у polls уже фактически есть (`pnpm build` → `.output`). Перенести
  `vibecode-deploy.sh` почти дословно, заменив `APP_NAME`, `PRESTART_CMD`, набор `ENV_JSON`
  (`DASHBOARD_AUTH_SECRET`, `DATABASE_URL`, `NUXT_BITRIX_TOKEN_KEY`, `NUXT_B24_*`,
  **`APP_EDGE_SECURITY=1`** — nginx там нет). Требует раздел 3.1.
- **Тонкость.** Если у polls появится пререндеренная install/landing-страница с абсолютным
  URL — `NUXT_PUBLIC_SITE_URL` пекётся на **build**-времени (рантайм-env не переинжектит);
  донор запекает его в команду сборки. Сейчас у polls такой страницы, похоже, нет — риск
  低, но учесть при вводе лендинга.
- **Приоритет.** 🟡 (запасной/канонический путь; после 3.1).

---

## 5. 🟠 Телеметрия (OpenTelemetry)

- **Проблема.** У polls есть логи (`obs/`), но нет **истории/трейсов/латентности по порталам**.
  На проде мультитенанта не видно: какие порталы активны, где падают B24-вызовы, какова
  латентность submit/дашборда. OTel это **дополняет** `obs/`, не заменяет.
- **Донор (два слайса).** **Слайс 1 (app-side, DEFAULT OFF):** `otel.instrument.mjs` грузится
  через `NODE_OPTIONS=--import` **до** приложения (Nitro-плагин был бы поздно + Nitro-бандлер
  ломает require-хуки OTel → deps ставятся отдельно `otel-preload-package.json` вне бандла,
  **точными** версиями = что тестит CI). Без `OTEL_EXPORTER_OTLP_ENDPOINT` — печатает
  `[otel] disabled`, ничего не поднимает (ноль оверхеда, поведение не меняется). Ручные спаны
  на `@opentelemetry/api` (no-op когда SDK не зарегистрирован): `withDependencySpan` (каждый
  исходящий B24-вызов), `withSpan` (job/фоновые), `withFrameRouteSpan` (HTTP-роуты фрейм-токена).
  **PII-защита тройная:** allowlist атрибутов на источнике (`telemetryAttributes.ts`
  `pickSafeAttributes` — только `dep.*`/`job.*`/`http.*`/`portal.hash`, скаляры) +
  redaction-SpanProcessor (срезает `db.statement`/`http.url`/токены авто-инструментирования) +
  `portalHash(memberId)` = SHA-256→12hex (вместо member_id) и `errorKind` (код, не текст ошибки).
  **Слайс 2 (общая станция):** `telemetry-station/` (otel-collector-contrib + ClickHouse 72ч +
  Grafana) — самодостаточный отдельный деплой, мультиапповый (различает по `service.name`),
  со **вторым** барьером PII в `collector/config.yaml`.
- **В polls.** `otel.instrument.mjs` + `otel-preload-package.json` + три `telemetry*.ts`
  переносятся дословно (чистые, DI). Адаптации: (а) свой allowlist под домен —
  `survey.responses`/`survey.version`/`portal.hash` вместо `proc.lines`; (б) обернуть роуты
  polls (`/api/submit`, `/api/dashboard/:key`, `/api/b24/session`) в `withFrameRouteSpan`,
  а OAuth-обмен/refresh — в `withDependencySpan`; (в) `NODE_OPTIONS=--import` в `Dockerfile`;
  (г) станцию переиспользовать как есть (polls — третий сервис рядом с procure-ai/client-bank).
  PII-риск у polls **выше** (дашборд с именами) → тройная защита особенно уместна;
  `portalHash` — прямой мэппинг с `portalId`. Закрывает деплой-хвост #15.
- **Env.** `OTEL_EXPORTER_OTLP_ENDPOINT` (база), `TELEMETRY_ENABLED` (0 — форс-выкл),
  `OTEL_EXPORTER_OTLP_HEADERS` (Bearer), `OTEL_SERVICE_NAME`/`_VERSION`.
- **Приоритет.** 🟠 (наблюдаемость прода мультитенанта; #15).

---

## 6. 🟡 Очереди — точечно, НЕ весь пайплайн

- **Честно.** У polls **нет** тяжёлого async-пайплайна (у донора это extract→agent→crm-sync).
  Тащить BullMQ целиком — избыточно. Но **три паттерна** ложатся прямо на открытые задачи polls.
- **6.1 Вебхук-через-очередь + синхронный фолбэк (для #17).** Донор: `events.post.ts`
  верифицирует → в очередь `b24-events` (единственный писатель на single-instance) → консьюмер
  `handleEventJob`; при недоступности Redis — **синхронный фолбэк** (`applyEventSync` тем же
  токен-стором), т.к. **B24 не ретраит online-события**. Общий чистый маппер
  (`eventJobToSaveInput`) для очереди И фолбэка → «no drift». Это **ровно** то, что нужно
  polls для #17 (`ONCRMDEALUPDATE` → `dealToCrmContext` → `handleDealTrigger` → приглашение)
  и для install/uninstall (раздел 2). **Без Redis polls берёт только синхронный путь** —
  паттерн работает уже сейчас, очередь добавляется позже. 🟠 (в связке с #17)
- **6.2 Роль-сплит + `queueEnabled()` no-op каркас (для #4/мульти-инстанс).** Донор:
  `runtime.ts` (`QUEUE_WORKERS`/`QUEUE_CRON` → роли single/primary/worker), `connection.ts`
  (`queueEnabled()` = задан `REDIS_URL`; без него всё **no-op** — dev не ломается),
  `plugins/queue.ts`. Даёт polls плавный путь к общему стору nonce/лимитов/приглашений (#4) и
  к тому, чтобы keep-alive-крон (2.4) шёл только на cron-роли (не дублировался на репликах).
  Каркас минимальный и чистый. 🟡 (когда встанет мульти-инстанс)
- **6.3 `RUN_MIGRATION=0` для реплик.** polls уже применяет миграции на старте
  (`applyMigrations`); паттерн «primary мигрирует, реплики пропускают» — при мульти-инстансе. 🟢
- **Если polls остаётся single-instance** — достаточно перенять идею **детерминированных
  job-id** и **синхронного фолбэка** на уровне обычных async-обработчиков, без BullMQ/Redis.
- **Env (когда/если).** `REDIS_URL`, `QUEUE_WORKERS`, `QUEUE_CRON`, `RUN_MIGRATION`.

---

## 7. 🟡 Рейтинг приложения («оцените приложение»)

- **Что это.** Модалка `B24Modal`, всплывающая **после ценного действия**, с троттлингом и
  ручным подтверждением отзыва оператором. Имеет смысл только для **Маркет-публикации**.
- **Донор.** `server/utils/appRatingPolicy.ts` (`shouldPrompt`, `RATING_REPROMPT_DAYS=4`),
  `appRatingStore.ts`, `appRatingStatus.ts`, `appRatingOpsHandler.ts`, роуты `app-rating.get/post`
  (фрейм-токен) + `ops/app-rating.*` (operator), `app/components/AppRatingModal.vue` +
  `useAppRating.ts`, `config/b24.ts` (`marketDetailPath` → `frame.slider.openPath('/marketplace/detail/<slug>/')`).
  Решение показа — **на сервере** (чистая `shouldPrompt`): `reviewed` → никогда; `opened_at`
  → заглушить до ручной проверки; иначе не чаще 4д. Факт отзыва Маркет по REST не отдаёт →
  владелец подтверждает из операторской консоли (`markReviewed`/`clearOpened`). UPSERT'ы с
  гардом `WHERE reviewed=false`.
- **В polls.** Триггер — **после успешного submit** (контур A, экран «Спасибо») или в дашборде.
  Таблица `portal_app_rating` + чистая политика в `src/` + два фрейм-роута + два ops-роута +
  модалка. polls уже имеет frame-handshake (`/api/b24/session`) + `resolveMemberIdByDomain` →
  фрейм-токен аутентификация ложится на готовое. Свой Market-слаг polls.
- **Миграция/env.** `portal_app_rating (member_id PK, prompted_at, opened_at, reviewed bool,
  created_at, updated_at)` (чистится в `deletePortal` — раздел 2). `NUXT_PUBLIC_B24_MARKET_CODE`.
- **Приоритет.** 🟡 (после Маркет-публикации; продуктовый рост).

---

## 8. 🟡 Обратная связь (виджет 👍/👎 → GitHub issue)

- **Отличие от `reporting-kit`.** reporting-kit шлёт **отчёты оператора** в Telegram по
  команде. Здесь — **пользовательская** обратная связь: 👍/👎 прямо в UI → issue в приватный
  GitHub-репо. Разные вещи, обе полезны.
- **Донор.** `app/utils/feedback.ts` (чистое ядро: `buildFeedbackIssue`, `sanitizeComment`,
  **`stripHostileChars`** — C0/bidi-оверрайды/zero-width/BOM, анти-Trojan-Source против
  ревьюера, `escapeHtml`, обёртка в `<pre><code>`), `server/utils/feedbackConfig.ts`
  (**fail-closed** — НЕ дефолтит на публичный репо), `feedbackGithub.ts` (POST issue, не
  логирует токен/URL/тело, ретрай на 5xx/429), роуты `feedback.post/get`, `FeedbackWidget.vue`
  + `useFeedback.ts`. 👍 шлёт сразу; 👎 сперва просит комментарий. Показ виджета — по
  `GET /api/feedback {enabled}`. Дедуп — на клиенте (localStorage).
- **В polls.** Триггер — экран «Спасибо» (контур A) или дашборд (контур B). Чистое `feedback.ts`
  (санитизация!) + `feedbackConfig` + `feedbackGithub` + два роута + виджет переносятся напрямую.
  **Важно:** `bx-shef/polls` — **публичный** репо, поэтому (а) приёмник-репо **обязан быть
  приватным** (напр. `bx-shef/polls-feedback`), (б) клиентский контекст (ключ опроса/номер
  сделки) класть в issue **только** т.к. приёмник приватный — fail-closed-логика донора
  (не дефолтить на публичный) здесь особенно важна.
- **Env.** `GITHUB_FEEDBACK_TOKEN`, `GITHUB_FEEDBACK_REPO` (приватный `owner/repo`, regex-валидация).
- **Приоритет.** 🟡 (продуктовый; санитизация Trojan-Source ценна в любом приёме свободного текста).

---

## 9. 🟢 Операторская консоль (частично уже есть)

- **Что это.** Служебная зона **владельца** — «управляй из UI, не из SQL/SSH»: health токенов
  порталов (без секретов), force-reauth, управление рейтингом, глубины очередей.
- **Донор.** `server/utils/session.ts` (HMAC-SHA256 подписанная cookie, constant-time) +
  `operatorSession.ts` (`OP_COOKIE`, 8ч) + `auth/login.post.ts` (анти-брутфорс) + `ops/*`
  роуты (`queues.get`, `tokens.get` — **SELECT физически без token-колонок**, `tokens/refresh.post`
  — переиспользует `reauthPortal`→advisory-lock) + `app/pages/queues.vue`.
- **В polls — фундамент уже стоит.** `src/api/session.ts` (HMAC-подпись) + `requirePortalSession`
  + `DASHBOARD_AUTH_SECRET` (fail-closed) — тот же паттерн. Добавить: (а) разделение
  **owner-зоны** от portal-зоны пользователя; (б) карточка token-health (домен/member_id/срок
  refresh — **без секретов**, отдельная не-секретная проекция); (в) force-reauth из UI (вместо
  SSH). Карточка очередей — только если раздел 6.
- **Env.** `OPERATOR_PASSWORD` (пусто → 503), `OPERATOR_SESSION_SECRET` (фолбэк на
  `NUXT_BITRIX_TOKEN_KEY`).
- **Приоритет.** 🟢 (операционное удобство мультитенанта).

---

## 10. Другие фишки и «структура»

### 10.1 🟢→🟠 AI-анализ открытых ответов (`answer_insight` пустует!)

- **Наблюдение.** В схеме polls (`migrations/0001`) **уже есть** таблица `answer_insight`
  (`theme`/`sentiment`/`intent`/`summary`/`model`) — задел под AI-разбор открытых ответов,
  который **не реализован**. Это естественная «звёздная» фича: датчик → **AI** → KPI/Лента
  (north-star из `brief.md`).
- **Донор.** Паттерн chat-движка (`server/agent/`): tool-less, чистый text→JSON, провайдер за
  флагом (`LLM_PROVIDER`: `deepseek`/`bitrixgpt`/`custom` → `{baseURL,apiKey,model}`), общий
  `retry.ts`, валидация вывода + гард `MAX_ITEMS`, живой адаптер на `openai` SDK. Инъекция
  документа не может ничего, кроме JSON.
- **В polls.** Порт паттерна: `src/` чистый `llmConfig`/`chatExtract` (провайдер-резолвер +
  оркестрация), живой адаптер в `server/`, за **очередью** (раздел 6.1 — AI-разбор долгий и
  ретраибельный) или в фоне. Заполняет `answer_insight` (sentiment/тема/интент открытых
  ответов) → дашборд контура B получает качественную аналитику поверх количественной.
- **Приоритет.** 🟢 сейчас (большая фича), но 🟠 стратегически — это north-star. Схема готова.

### 10.2 Инженерные принципы донора — закрепить явно

polls уже следует большинству, но стоит записать в `decisions.md` как общий стиль:
1. **Чистое ядро (DI, unit-тесты) + тонкая живая обёртка** — у polls это уже строже донора
   (framework-agnostic `src/` + `check:boundary`). Держать: новые куски (events/verify/keepalive/
   edge/telemetry/feedback/rating) — чистыми в `src/`, обёртками в `server/`.
2. **Секреты из `process.env` напрямую, НЕ через `useRuntimeConfig()`** (Nuxt мапит только
   `NUXT_`-префикс) — иначе install/handshake молча ломается. Проверить существующие роуты.
3. **Fail-closed / DEFAULT-OFF за env-флагами** (у polls уже: dashboard-auth, token-key;
   добавить: feedback-config, edge-security, telemetry, member-verify).
4. **«No drift» через общие чистые мапперы** (один код-путь для очереди и фолбэка; CSP как
   общая константа; точные версии OTel-preload = что тестит CI).
5. **Не-секретные проекции** для любых UI/ops-чтений (SELECT без token-колонок).
6. **Constant-time сравнения** для токенов/паролей (у polls уже `verifyApplicationToken`).

### 10.3 Структура каталогов и dev-среда

- **Добавить `server/plugins/`** (сейчас нет) — для запуска keep-alive/tombstone-sweep
  (2.4/2.2) и, при вводе, очередей (6). Сейчас инициализация ленивая в `server/utils/api.ts` —
  таймеры туда не ложатся.
- **Добавить `server/middleware/`** (сейчас нет) — для edge-security (3.1).
- **ESLint** — у polls его нет (донор имеет `eslint.config.mjs`). Ядро уже дисциплинировано
  `tsc strict` + тесты; ESLint — низкий приоритет, но добавил бы единый стиль `.vue`/`server`.🟢
- **`docs/data-policy.md`** — новый документ: что хранится, что удаляется при uninstall
  (раздел 2), retention/тумбстоун, PII в дашборде. Требование Маркета; у донора это
  `docs/redesign/05-data-policy.md`. 🟠 (в связке с разделом 2)
- **Консолидация деплой-доков** — `admin-setup.md` описывает nginx-proxy-путь; добавить
  `DEPLOY_VIBECODE.md` (раздел 4) и OTel-раздел (5).

---

## 11. Приоритизация и последовательность

```
Фаза A 🔴 lifecycle-hardening (почти-баги)     Фаза D 🟡 продуктовый рост
  2.1 uninstall + удаление данных   ─┐            7 рейтинг приложения
  2.2 тумбстоун + UPDATE-only        ├─ 1 миграция 8 виджет обратной связи
  2.4 keep-alive рефреш             ─┘  + 1 таймер  9 операторская консоль
  2.3 member_id binding                          (после Маркет-публикации)
        │
        ▼                                       Фаза E 🟢/🟠 north-star
Фаза B 🟠 устойчивость деплоя                     10.1 AI-разбор ответов
  3.* изоляция БД / healthcheck / CI-gate         (+ очередь 6.1)
  3.1 edge-security ──────────┐
        │                     │
        ▼                     ▼
Фаза C 🟠 наблюдаемость     Фаза (опц.) 🟡 «чёрная дыра»
  5 OpenTelemetry (#15)       4 vibecode-deploy (нужен 3.1)
```

| Фаза | Что | Приоритет | Зависит | Связь с issues |
|---|---|---|---|---|
| **A** | uninstall + тумбстоун + keep-alive + member_id + UPDATE-only | 🔴 | — | новое; смежно #17 |
| **B** | изоляция БД, healthcheck, CI→publish gate, **edge-security** | 🟠 | — / A | #47 (PII), #31 |
| **C** | OpenTelemetry (app-slice + станция) | 🟠 | — | #15 |
| **D₁** | event-webhook + sync-фолбэк (binding `ONCRMDEALUPDATE`) | 🟠 | A | **#17** |
| **D₂** | рейтинг + feedback-виджет + операторская консоль | 🟡 | A, (Маркет) | новое |
| **E** | «чёрная дыра» (опц.) · роль-сплит/Redis (#4) · AI-разбор | 🟡/🟢 | B, 3.1 | #4, north-star |

**Рекомендация.** Начать с **Фазы A** — это единственный блок, где бездействие = потеря
данных/токенов и cross-tenant-риск (одна миграция + один плагин-таймер + чистые функции под
тесты; полностью в духе существующего `PgStore`). Далее B+C (устойчивость+видимость прода),
затем D (связка портала #17 + продуктовые фичи). E — по стратегии.

---

## 12. Чего НЕ переносить (анти-карго-культ)

- **Полный пайплайн `extract→agent→crm-sync`** — у polls нет тяжёлой обработки документов.
- **Двухобразная топология (nginx `app` + Nitro `backend`)** — polls за общим `nginx-proxy`
  уже имеет TLS; отдельный CSP-слой дешевле закрыть edge-security (3.1). Один образ.
- **OCR-тулчейн / `claude-code` CLI в prestart** — специфика донора; у polls prestart «чёрной
  дыры» = только `postgresql`.
- **BullMQ/Redis как обязательная зависимость** — вводить только с мульти-инстансом (#4);
  до этого синхронный путь + детерминированные job-id достаточны.
- **Легаси-каталог `legacy/`** — у polls нет предшественника; переносить нечего.

---

## Приложение: сводная таблица переноса

| # | Подсистема донора | Переносимость | Приоритет | Ключевые файлы-образцы (донор) |
|---|---|---|---|---|
| 2.1 | uninstall-события | Высокая | 🔴 | `api/b24/events.post.ts`, `utils/b24EventsHandler.ts`, `app/utils/b24Events.ts` |
| 2.2 | тумбстоун + UPDATE-only | Высокая | 🔴 | `utils/tokenStore.ts`, `utils/retentionSweep.ts`, `plugins/retention.ts` |
| 2.3 | member_id binding | Высокая (sec) | 🟠 | `utils/verifyInstallMember.ts`, `utils/verifyInstallToken.ts` |
| 2.4 | keep-alive рефреш | Высокая | 🔴 | `utils/tokenKeepAlive.ts`, `utils/accessToken.ts` |
| 2.5 | advisory-lock рефреш | Средняя | 🟡 | `utils/dbLock.ts`, `utils/ensureAccessToken.ts` |
| 3 | Docker/GHCR/Watchtower+ | Высокая | 🟠 | `docker-compose.prod.yml`, `Dockerfile`, `deploy.yml` |
| 3.1 | edge-security | Высокая | 🟠 | `utils/edgeSecurity.ts`, `middleware/edgeSecurity.ts` |
| 4 | «чёрная дыра» vibecode | Высокая | 🟡 | `deploy/vibecode-deploy.sh`, `.github/workflows/deploy-vibecode.yml` |
| 5 | OpenTelemetry | Высокая | 🟠 | `otel.instrument.mjs`, `otel-preload-package.json`, `utils/telemetry*.ts`, `telemetry-station/` |
| 6 | очереди (точечно) | Точечная | 🟡 | `queue/{connection,runtime,topology}.ts`, `plugins/queue.ts` |
| 7 | рейтинг приложения | Высокая | 🟡 | `utils/appRating*.ts`, `components/AppRatingModal.vue` |
| 8 | feedback-виджет | Высокая | 🟡 | `app/utils/feedback.ts`, `utils/feedbackGithub.ts`, `components/FeedbackWidget.vue` |
| 9 | операторская консоль | Средняя (часть есть) | 🟢 | `utils/{session,operatorSession}.ts`, `api/ops/*` |
| 10.1 | AI-разбор ответов | Высокая (схема готова) | 🟢/🟠 | `server/agent/{llmConfig,chatExtract,openaiChat}.ts` |

---
*Последнее ревью: 2026-07-22.*
