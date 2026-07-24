# Карта проекта — polls (сервис опросов для Bitrix24)

> Last reviewed: 2026-07-23
>
> **Единая карта проекта.** Всё техническое и справочное — здесь. Как сервис работает
> «простыми словами» и как управлять опросами — в [`process.md`](./process.md).
> Открытые задачи — в [`issues.md`](./issues.md). Обезличенный шаблон схемы —
> [`reference/survey-schema.template.json`](./reference/survey-schema.template.json).

## Что это и зачем

**polls** — сервис анонимных опросов, встроенный в Bitrix24. Опрос запускается по событию в
CRM (закрытие сделки), клиент проходит его в пару кликов, руководитель видит готовую аналитику
без выгрузок. Формула продукта:

> **Датчик (событие CRM) → Опрос → Аналитика (KPI / Лента портала).**

- **North-star** — рабочий сервис опросов в связке с Bitrix24 (датчик → AI → KPI/Лента).
- **Brain-first.** Продаём не анкеты, а решения: сам опрос — самый дешёвый датчик, защищённый
  ров — AI-анализ, превращающий ответы (включая фритекст «Другое») в число (CSAT/NPS) + причину
  (тег) + следующее действие. Опрос — переиспользуемый движок, контент декларативен в JSON-схеме.
- **Развёрнут вживую:** `polls.bx-shef.by` (Docker + nginx-proxy + TLS + PostgreSQL,
  авто-CD merge→GHCR→watchtower). Установка на портал работает.
- **Модель развёртывания:** локальное приложение — **1 портал = 1 инстанс = своя БД**
  (`portalId` = `member_id`); кросс-портальной мультитенантности нет.

Свойства опроса: анонимный (без ПД, без авторизации), ~5–7 мин, 25 вопросов / 8 блоков, типы
`single`/`multi`/`text`, спец-механики («Другое+текст», взаимоисключающие, необязательные),
прогресс в `localStorage` (возврат/дозаполнение), повтор после отправки недоступен, 1 опрос = 1
язык (платформа мультиязычна).

Комментарии и документация — на русском. Стек: **framework-agnostic ядро** (`src/`, TypeScript) +
**Nuxt 4 / b24ui-приложение** (контур A `/s/:key` + дашборд контура B `/d/:key` + admin `/admin/*`) +
**Nitro-привязка** (`server/`).

---

## Оглавление

1. [Статус (одним взглядом)](#статус-одним-взглядом)
2. [Архитектура](#архитектура)
3. [Данные (PostgreSQL) и аналитика](#данные-postgresql-и-аналитика)
4. [Интеграция с Bitrix24](#интеграция-с-bitrix24)
5. [Безопасность и инварианты](#безопасность-и-инварианты)
6. [Деплой и эксплуатация](#деплой-и-эксплуатация)
7. [Наблюдаемость](#наблюдаемость)
8. [Дизайн (b24ui)](#дизайн-b24ui)
9. [Визуальный гейт](#визуальный-гейт)
10. [Ключевые решения](#ключевые-решения)
11. [Дальнейшая работа](#дальнейшая-работа)
12. [Рабочий процесс (задача → PR → review → мерж)](#рабочий-процесс-задача--pr--review--мерж)
13. [Глоссарий](#глоссарий)
14. [Команды](#команды)

---

## Статус (одним взглядом)

Легенда: ✅ сделано и под тестами · 🟡 сделано, требует живой проверки/деплоя · ⏳ в работе/план.

| Слой | Что | Статус | Что проверить |
|---|---|---|---|
| `domain/` | схема/метрики/ответы/компиляция/агрегация (zod, 4 уровня) | ✅ | — |
| `store/` | `IStore` + `MemoryStore` + `PgStore` (PostgreSQL, tenant-scoped) | ✅ | прод-прогон на PostgreSQL (персистентность) |
| `api/` | `createApi` + анти-абьюз (nonce/ratelimit/honeypot/invitation) + HTTP-кэш ETag | ✅ | общий стор для мульти-инстанса (#4) |
| `obs/` | логгер (redact секретов)/health/process-хуки | ✅ | адаптеры Pino/Sentry/OTel (#5/#15) |
| `bitrix24/` | crypto (AES-256-GCM)/oauth/portal/install-lifecycle/frame/deal-event/client | ✅ | живой app-mode smoke |
| `client/` | `SurveyFill` (прохождение) · `survey-editor` (конструктор) | ✅ | — |
| `app/` (Nuxt 4 + b24ui) | контур A (`/s/:key`) + дашборд B (`/d/:key`) + admin (`/admin/*`) | ✅ | под визуальным гейтом |
| `server/` (Nitro) | обёртки ядра: session · submit · survey · health · dashboard · admin · b24/* | ✅ | стор по `DATABASE_URL`: PgStore (прод) / MemoryStore+seed (dev) — живой прогон |
| Визуальный гейт | Playwright скриншот-регрессия + Stop-хук: 48 эталонов (8×3×2) | ✅ | в CI — #41 |
| **OAuth-lifecycle портала (Фаза A)** | тумбстоун + UPDATE-only refresh + keep-alive + uninstall (CLEAN-респект) + member_id-binding + SSRF-allowlist + rate-limit install | ✅ **закрыто по коду** | **живой install-smoke на портале** |
| Установка Bitrix24 | `/api/b24/install` (токены + робот + плейсменты) + handshake `/api/b24/session` | 🟡 код готов | живой install-smoke (ещё не прогонялся) |
| Связка CRM→`CrmContext` (чтение) | маппинг deal/lead/spa/contact/company/task + `products` + формат стадий | ✅ **live-verified вебхуком** (2026-07-23) | binding-эндпоинты (#17) |
| Деплой-слой | Docker+GHCR+watchtower+nginx-proxy+TLS+PostgreSQL, авто-CD | 🟡 **live** (`polls.bx-shef.by`) | мульти-инстанс (#4) · OTel (#15) · edge-security |

**Что сделано за последний цикл (PR #109–#115, все смержены):** устойчивость OAuth-lifecycle
портала (тумбстоун/UPDATE-only, keep-alive, uninstall+удаление данных, member_id-binding),
закрытие **реальной SSRF-дыры** в allowlist домена (затрагивала и handshake фрейма #47),
rate-limit install, HTTP-кэш ETag/условный-GET (#30), обогащение `products` в `CrmContext`
(найдено живой проверкой через вебхук — прод-путь молча ронял срез «услуга/товар»).

**Главные незакрытые куски (в порядке ценности):**
1. **Живая верификация прод-стека.** Привязка PgStore **сделана в коде** (`server/utils/api.ts`: пул +
   миграции + `ensureDefaultPortal` + `setPortalResolver`) и разведена в `docker-compose.prod.yml`
   (Postgres + volume `db-data`) — но end-to-end на живом сервере **ни разу не прогонялась**: подтвердить
   персистентность (запись → редеплой → чтение) и round-trip handshake фрейма. Это **верификация, не
   стройка**. Остаток мульти-портала (per-portal tenant-фильтр) — **#49**.
2. **Живой install-smoke** Фазы A на тест-портале (install-page + событие → токен captured → персист →
   handshake 200 → uninstall CLEAN=1/0).
3. **#17** — авто-триггер `ONCRMDEALUPDATE`: эндпоинт `/api/b24/deal-update` + `event.bind` при install
   **сделаны в коде** (`runDealUpdate`, под тестами); ядро/маппер/формат стадий live-verified. Остаётся
   **живой smoke** на портале + доставка ссылки адресату (email/SMS).
4. **#49** tenant-фильтр мульти-портала · **#15** OTel/Pino/Sentry · **#4** общий стор анти-абьюза.

---

## Архитектура

Ядро (`src/`) — **framework-agnostic**, Nuxt его не сканирует (`nuxt.config.ts` задаёт `srcDir: 'app/'`,
алиас `~core → src/`). Зависимости инжектируются → всё под юнит-тестами без живого портала.

### Ядро `src/`

- **`domain/`** — чистая доменная логика.
  - `schema.ts` — **единый источник истины** типов и валидации (zod). Enum'ы (`QUESTION_TYPES`,
    `METRICS`, `ENTITY_TYPES`) и структуры (`CompiledVersion`, `ResponseRecord`, `CrmContext`,
    `StoredAnswer`, `InvitationPolicy`) выводятся из zod-схем — TS-тип и runtime-валидация не расходятся.
    Даты — `z.string().datetime()` (ISO-8601). Презентация (`intro`/`thanks`/`blocks`, #25) и
    `invitationPolicy` (#21) вшиты в version-frozen снимок.
  - `metrics.ts` — чистые метрики (nps/csat/ces/distribution).
  - `answers.ts` — серверная нормализация/валидация ответов (устойчива к подделке ключей).
  - `compile.ts` — компиляция черновика в иммутабельную версию + `diffVersions` (классы изменений
    по стабильному `question_key`).
  - `aggregate.ts` — агрегация на 4 уровнях + KPI/тренд; `breakdownBy`, `npsTrend(minN)`;
    `ANONYMITY_THRESHOLD = 5`, `meetsAnonymity`.
- **`store/`** — `types.ts` (`IStore`) + `memory.ts` (`MemoryStore`) + `pg.ts` (`PgStore`,
  драйвер-агностичная поверх `pg.Pool`/pglite, tenant-scoped по `portalId`, SQL-агрегация с
  принудительным подавлением малых N, durable-идемпотентность по `invitation_token`) + `cursor.ts`
  (keyset-курсор).
- **`api/`** — `handlers.ts` (`createApi`: framework-agnostic HTTP-хендлеры) + `nonce.ts` +
  `ratelimit.ts` (`SlidingWindowLimiter`) + `invitation.ts` (single-use) + `session.ts` (HMAC-подпись
  сессии портала) + `http-cache.ts` (ETag/условный-GET, #30).
- **`obs/`** — `logger.ts` (`Logger`/`createJsonLogger`/`redact`) + `process.ts` (`installProcessHandlers`).
- **`bitrix24/`** — интеграция (server-only):
  - `crypto.ts` — `TokenCipher` (AES-256-GCM с `kid`), `loadTokenKey` startup-guard.
  - `oauth.ts` — `Bitrix24OAuth` (обмен кода/refresh POST-телом; `OAuthError.status`).
  - `portal.ts` — `PortalTokenStore` (шифрованное хранение + авто-refresh, lifecycle-hardening:
    тумбстоун, `updateOnRefresh` UPDATE-only, `deletePortal` каскад в транзакции, `listNearExpiry`),
    `resolveMemberIdByDomain`.
  - `keep-alive.ts` — `runKeepAlive`/`keepAliveIntervalMs` (рефреш порталов у истечения refresh_token).
  - `uninstall.ts` + `bracket-form.ts` — обработка `ONAPPUNINSTALL` (constant-time сверка
    `application_token`, респект `data.CLEAN`, гард prototype-pollution).
  - `verify-install.ts` — member_id-binding (`verifyInstallMember`, `applyVerifiedTokens`,
    `decideInstallDoubleDispatch`).
  - `frame.ts` — handshake app-фрейма (`isAllowedPortalDomain` SSRF-allowlist, `verifyFrameAuth`,
    `mintPortalSession`).
  - `authenticate.ts` — боевой `PortalAuthenticator` (`app.info` + резолв `member_id`).
  - `deal-event.ts` / `entity-event.ts` — триггер `ONCRMDEALUPDATE` + мульти-сущность
    (`parseDealUpdateEvent`, `verifyApplicationToken`, `dealToCrmContext(deal, productRows?)`,
    `mapProductRows`, `entityToCrmContext`).
  - `task.ts` — ручной запуск из карточки задачи; `survey-routing.ts` — какой опрос по сущности
    (env `SURVEY_KEY_*`); `trigger.ts` — `handleDealTrigger`/`createSurveyInvitation`;
    `client.ts` — REST-клиент на `@bitrix24/b24jssdk` (`dealGet`/`dealProductRows`/`taskGet`/`entityGet`).
  - `install.ts` — оркестрация установки (робот `bizproc.robot.add` + плейсменты).
- **`client/`** — `survey-fill.ts` (`SurveyFill` — «мозг» прохождения, без DOM) + `survey-editor.ts`
  (логика конструктора: ключи, add/remove/reorder, `normalizeForPublish`).
- **`demo/seed.ts`** — детерминированный демо-набор (общий для `verify` и тестов).

### Приложение `app/` (Nuxt 4 + b24ui)

- **Контур A** (`app/pages/s/[key].vue` + `components/survey/*`): intro→survey→thanks через композабл
  `useSurvey.ts` (тонкая реактивная обёртка над `SurveyFill`, `shallowRef`+bump). Версию грузит через
  `useAsyncData` (SSR-payload); тип `PublicVersion` (без `invitationPolicy`). Persist + deep-link (`?q=N`)
  + тёмная тема (`@nuxtjs/color-mode`) + тоггл темы (`B24ColorModeButton`).
- **Дашборд контура B** (`app/pages/d/[key].vue`): read-аналитика (NPS/CSAT/распределение/тренд/срезы)
  через `domain/aggregate`; малые N подавлены; фильтр по версии (`?version=N`); нативная b24ui-тема;
  auth `requirePortalSession` (fail-closed в проде).
- **Admin-UI** (`app/pages/admin/surveys/`): список + конструктор поверх `/api/admin/surveys*`.
- **Граница `~core` (важно для безопасности):** из клиентских `.vue`/composables — ТОЛЬКО `~core/client`
  и `~core/domain` (чистая логика без секретов). `~core/{bitrix24,store,api,obs}` — **server-only**
  (Nitro-роуты). Форсится в CI: `pnpm check:boundary`.

### Nitro-привязка `server/`

Тонкие обёртки над `createApi` (`server/utils/api.ts` — `useApi()`/`useStore()`, инстанс на процесс:
пока MemoryStore+seed для dev-паритета) + роуты `server/api/`:
`GET /api/session`, `POST /api/submit`, `GET /api/survey/:key/current` (+ ETag/304, #30),
`GET /api/health`, `GET /api/dashboard/:key`, `GET/POST /api/admin/surveys*`,
`POST /api/b24/session` (handshake фрейма), `POST /api/b24/install` (+ ветка `ONAPPUNINSTALL`),
`POST /api/b24/deal-invite` · `task-invite` (ручной запуск из виджетов).
Плагин `server/plugins/keepalive.ts` — таймер keep-alive-рефреша.

---

## Данные (PostgreSQL) и аналитика

Схема — `migrations/*.sql` (`node-pg-migrate`, `pnpm migrate up`); те же `.sql` применяют pglite-тесты
(единый источник). Иерархия:
`portal → app_user → survey_group → survey → survey_version → survey_question → survey_option`,
плюс `invitation` → `response` → `response_answer`/`response_product`/`answer_insight`.

### Таблицы (ключевые колонки)

- **`portal`** (≈1 строка): `id`, `member_id UNIQUE`, `domain`, `tokens jsonb` (OAuth, шифруется
  приложением), `application_token` (0004; избыточна — токен уже в blob), `updated_at` (свежесть →
  keep-alive), `installed_at`.
- **`portal_tombstone`** (0004): `member_id PK`, `deleted_ts bigint` (unix-**секунды**) — out-of-order
  install после uninstall не воскрешает удалённый портал.
- **`app_user`**: `b24_user_id`, `role` (author/admin/viewer), `UNIQUE(portal_id, b24_user_id)`.
- **`survey_group`**: `visibility` (private/department/portal), `visibility_ref` (id отдела).
- **`survey`**: `survey_key` (стабилен), `lang default 'ru'`, `status` (draft/active/paused/archived),
  `current_version_id`, `UNIQUE(group_id, survey_key)`.
- **`survey_version`** (иммутабельна): `version_no`, `status` (draft/published/archived),
  `compiled_schema jsonb`, **`trigger_stages text[]`** (денормализация `invitationPolicy.triggerStages`,
  #22, **GIN-индекс**), `UNIQUE(survey_id, version_no)`.
- **`survey_question`**: `question_key` (стабилен), `block`, `position`, `type`, `metric`, `required`,
  `columns`, `UNIQUE(version_id, question_key)`.
- **`survey_option`**: `option_key` (стабилен), `label`, `score` (шкальные), `is_other`, `is_exclusive`.
- **`invitation`**: `survey_version_id` (**ПИН версии**), `token UNIQUE`, `channel`, `status`, снимок
  CRM (`deal_id`/`deal_category_id`/`deal_stage_id`/`company_id`/`contact_id`/`responsible_id`/
  `deal_amount`/`context jsonb`).
- **`response`**: `invitation_id`, `version_no`, денорм-снимок (`deal_id`/`company_id`/`contact_id`/
  `responsible_id`/`deal_category_id`), кэш метрик (`nps_value`/`csat_value`/`sentiment` — резерв под
  BI/AI, `addResponse` их НЕ заполняет), `invitation_token` (durable-идемпотентность, 0003),
  `submitted_at`. Индексы: `(survey_id)`, `(company_id)`, `(deal_category_id)`, `(responsible_id)`,
  `(submitted_at)`; частичный `UNIQUE(portal_id, invitation_token) WHERE invitation_token IS NOT NULL`
  (повтор на любом инстансе → `ON CONFLICT DO NOTHING`; NULL = публичная ссылка, не дедупится).
  Имена подписей срезов (`companyName`/`dealCategoryName`/`responsibleName`) — в JSONB `context` (lossless).
- **`response_answer`**: `question_key`, `metric`, `value_choice text[]`, `value_number`, `value_text`
  (verbatim + «Другое»). Индекс `(question_key)`.
- **`response_product`**: `(response_id, product_id) PK`, `product_name`, `service_tag` — срез «услуга/товар».
- **`answer_insight`** (AI, перезапускаемо): `theme`, `sentiment` (-1..1), `intent`
  (recovery/upsell/praise/bug/none), `summary`, `model`.

### Версионирование

Иммутабельная версия (пин на приглашении при отправке). Классы изменений по `question_key`/`option_key`:
правка текста — тот же ключ (полная сопоставимость); новый вариант — новый `option_key` (частичная);
смена смысла/метрики — **новый `question_key`** (намеренный разрыв). Аналитика агрегирует по
`(metric, question_key)`, не по тексту/номеру версии.

### Аналитика (4 уровня)

`NPS` = %[9–10] − %[0–6]; `CSAT` = среднее/доля топ-бокса. Уровни: (1) по опросу; (2) по услуге/товару
(`response_product`); (3) по клиенту в динамике (`date_trunc('month')`); (4) по направлению + KPI
ответственных с порогом значимости `HAVING count(*) >= 5`. Реализация — `PgStore.aggregate*` +
`domain/aggregate`.

### Retention / erasure / приватность

- **Удаление данных за период** (ручная операция; кнопка — отдельная задача), tenant-scoped:
  ```sql
  -- необратимо; только нужный портал+период; сделать бэкап
  delete from response
   where portal_id = (select id from portal where member_id = '<member_id>')
     and submitted_at < '2026-01-01T00:00:00Z';
  ```
  `response_product` — каскадом (FK); `survey_version` не трогаем.
- **PII-erasure** (#4/#31) должен чистить `response.context` (JSONB), денормализованные колонки
  (`contact_id`…) и `response_product.product_name`.
- **Порог анонимности** `ANONYMITY_THRESHOLD = 5` (`meetsAnonymity`); принудительное подавление — в
  `PgStore.aggregate*` (нельзя обойти, читая агрегат напрямую).
- **Tenant-изоляция** по `portalId` (`PgStore` tenant-scoped).

---

## Интеграция с Bitrix24

### Маппинг CRM → `CrmContext`

| `CrmContext` | REST-источник | Уровень аналитики |
|---|---|---|
| `dealId` | `crm.deal.get` → `ID` | — |
| `dealCategoryId` | `CATEGORY_ID` | направление |
| `dealStageId` | `STAGE_ID` | (срез по стадии) |
| `companyId` | `COMPANY_ID` | клиент |
| `contactId` | `CONTACT_ID` | (адресат приглашения) |
| `responsibleId` | `ASSIGNED_BY_ID` | KPI сотрудника |
| `dealAmount` | `OPPORTUNITY` | (вес/денежный) |
| `products[].productId`/`productName` | `crm.deal.productrows.get` → `PRODUCT_ID`/`PRODUCT_NAME` | услуга/товар |

Имена (`companyName`/`dealCategoryName`/`responsibleName`) — обогащением (`crm.company/category/user.get`),
до него срезы падают на ID. Прочие сущности (`entity-event.ts`): лид (`STATUS_ID`), смарт-процесс
(`stageId`, нужен `spaEntityTypeId`), контакт/компания (без стадии → ручной запуск). `dealStageId` —
обобщённый триггер-ключ (имя историческое).

### Формат `STAGE_ID` (live-verified, 2026-07-23)

- Дефолтная воронка (`CATEGORY_ID=0`): **голые** стадии `NEW`, `PREPARATION`, `PREPAYMENT_INVOICE`,
  `EXECUTING`, `FINAL_INVOICE`, `WON`, `LOSE`, `APOLOGY`.
- Кастомная воронка N: **с префиксом** `C<N>:NEW`, …, `C<N>:WON`.

Это и есть формат `invitationPolicy.triggerStages`; `dealToCrmContext` захватывает `STAGE_ID` как есть,
`surveysTriggeredBy(stageId)` матчит по строке (GIN, #22).

**`products`** обогащаются ОТДЕЛЬНЫМ вызовом `crm.deal.productrows.get` (best-effort, провал →
`b24_deal_productrows_fail`). `mapProductRows` усекает до капов схемы (≤50 позиций / имя ≤500 — иначе
`parse` throw → 502), дедупит по `productId`, отбрасывает free-form-строки (`PRODUCT_ID=0`, услуга без
каталога — группировать нечем; **известное ограничение** среза для сервис-сделок).

### Установка и lifecycle портала (Фаза A — закрыто по коду)

- **Установка** `/api/b24/install` (два формата: install-страница + событие `ONAPPINSTALL`):
  парс → **member_id-binding** (`verifyInstallMember`: синхронный рефреш присланного `refresh_token` →
  сверка authoritative `member_id`; **403 только 400/401/mismatch**, всё прочее — 429/5xx/сеть/пустой →
  **503** транзиент; рефреш обёрнут `AbortSignal.timeout` 10с) → `applyVerifiedTokens` (ротированный
  грант; `clientEndpoint` **всегда** = `https://<domain>/rest/`) → домен валидируется
  `isAllowedPortalDomain` ДО REST → `handleInstall` (сохранить токены + робот `bizproc.robot.add` + 2
  плейсмента). Rate-limit `allowB24Install` 20/60с ДО рефреша (анти-амплификация). Идемпотентность
  двойной доставки — `decideInstallDoubleDispatch`.
- **Uninstall** `ONAPPUNINSTALL` (fail-open 200 — B24 не ретраит): `decideUninstall` (constant-time
  сверка `application_token`, респект `data.CLEAN`) → `deletePortal` (тумбстоун + каскадное удаление
  данных портала в транзакции).
- **Keep-alive** (`server/plugins/keepalive.ts` + `runKeepAlive`): суточный рефреш порталов у истечения
  refresh_token (~180 дней) — иначе простаивающий портал теряет токен. Гейт на `NUXT_B24_CLIENT_ID/SECRET`,
  каденция `TOKEN_KEEPALIVE_HOURS`.
- **Handshake app-фрейма** `POST /api/b24/session` (#47): `parseFrameAuth` → `verifyFrameAuth`
  (SSRF-allowlist домена + сверка `member_id` из авторитетного источника, не из POST) → подписанная
  сессия в cookie `polls_portal` (`SameSite=None; Secure; Partitioned`). Резолвер `domain → member_id`
  инжектируем — PgStore-привязка в #49, до неё handshake fail-closed (401).
- **Плейсменты/встройки:** `CRM_DEAL_DETAIL_ACTIVITY` (виджет сделки), `CRM_ANALYTICS_MENU` (дашборд),
  `TASK_VIEW_SIDEBAR` (виджет задачи). Ручной запуск — `deal-invite`/`task-invite`.

### Сценарии применения

- **Сценарий A** (платный клин): сделка → триггер-стадия → робот/событие → ссылка клиенту → AI-анализ
  verbatim (CSAT/NPS + тема + тональность) → результат в CRM (таймлайн/KPI) → петля (детрактор →
  задача recovery; промоутер → запрос отзыва). KPI **анонимизированный**.
- **Сценарий B** (бесплатный): `im.*` → анонимный сбор (eNPS/пульс) → в Ленту (`log.blogpost.add`)
  **только агрегаты**.

### Живой smoke (read-путь) — `scripts/b24-smoke.ts`

Через inbound-вебхук (`B24_WEBHOOK_URL`) читает реальные сделки → `dealToCrmContext` → 4-уровневая
агрегация. Только ЧТЕНИЕ. **Приватность:** домен/токен портала НЕ коммитим (только env); ПДн контактов
не печатаем. Верифицировано 2026-07-23: read-путь 8/8 сделок валидны, формат стадий и `products` сходятся.
Прогон **режима приложения** (install → handshake → виджеты → дашборд) — ручной плейбук в разделе Деплой;
код готов (PgStore разведён в прод-compose), ждёт **живого прогона** на портале.

---

## Безопасность и инварианты

- **SSRF-allowlist домена** (`isAllowedPortalDomain`, `frame.ts`): регекс
  `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bitrix24\.(?:[a-z]{2,}|com\.br)$` — ровно один лейбл портала +
  `.bitrix24.` + один TLD-лейбл (или явный `com.br`). **Была MAJOR-дыра** (открытая «двойная TLD»-ветка
  пропускала `foo.bitrix24.evil.com`) — закрыта; остаточно `bitrix24.<регистрируемый-gTLD>` →
  явный whitelist TLD (follow-up).
- **member_id-binding** — защита от install-poisoning (владелец портала A с чужим `member_id`): рефреш
  доказывает владение грантом; authoritative `member_id` обязан совпасть.
- **Тумбстоун + UPDATE-only refresh** — out-of-order install после uninstall не воскрешает портал.
- **Анти-абьюз** (`api/`): honeypot (`hp` непустой → 400), одноразовый nonce (TTL 15 мин, replay → 409),
  rate-limit по IP (скользящее окно → 429), invitation single-use (replay → 409, unknown → 403, чужой
  пин → 409), durable-идемпотентность записи по `invitation_token`.
- **Шифрование OAuth-токенов** — AES-256-GCM с `kid` в blob (форвард-совместимость ротации ключа);
  `loadTokenKey` startup-guard.
- **constant-time** сверка `application_token` (`verifyApplicationToken`, `timingSafeEqual`).
- **Инварианты ядра:** стабильные `question_key`/`option_key` (якоря сопоставимости); опубликованная
  версия иммутабельна; валидация на границах (`compile()`, `addResponse()`); подавление малых N и
  tenant-изоляция — ответственность слоя чтения/PgStore.
- **Редакция секретов в логах** (`redact` по имени ключа: token/secret/password/…); `redact` НЕ трогает
  доменные `surveyKey`/`questionKey`/`optionKey`.
- **Граница `~core`** форсится в CI (`check:boundary`): server-only ядро (крипто/токены/SQL) не в
  клиентском бандле.

---

## Деплой и эксплуатация

Приложение выбирает стор по `DATABASE_URL` (`server/utils/api.ts`): **задан** → **PgStore** (миграции на
старте + `ensureDefaultPortal` + `setPortalResolver`, данные **персистятся**); **не задан** →
**MemoryStore + сид** (демо, данные эфемерны). Прод-`docker-compose.prod.yml` разводит Postgres + volume
`db-data` — штатный прод идёт на **PgStore**. Осталось: **живой прогон** прод-стека (подтвердить
персистентность запись→редеплой→чтение + handshake).

### Переменные окружения

| Переменная | Зачем | Обязательна |
|---|---|---|
| `DASHBOARD_AUTH_SECRET` | HMAC-подпись сессии дашборда + handshake портала (**≥ 32**) | да в проде |
| `DASHBOARD_DEV_OPEN` | `=1` — открыть дашборд без сессии (ТОЛЬКО демо; в проде утечёт PII) | нет |
| `NUXT_BITRIX_TOKEN_KEY` | шифрование OAuth-токенов (AES-256-GCM, **≥ 64 hex**, `openssl rand -hex 32`) | да при связке |
| `NUXT_B24_CLIENT_ID` / `NUXT_B24_CLIENT_SECRET` | OAuth-креды приложения Bitrix24 | да при связке |
| `DATABASE_URL` | строка подключения PostgreSQL (прод; та же для CLI миграций) | да в проде |
| `POSTGRES_PASSWORD` | пароль БД для docker-compose | да при `db` |
| `SURVEY_KEY_<ENTITY>` | опрос по сущности из виджета (`_DEAL`/`_LEAD`/`_SPA`/`_CONTACT`/`_COMPANY`/`_TASK`) | нет (дефолт `csat_postdeal`) |
| `SURVEY_KEY_DEFAULT` | опрос по умолчанию, если для сущности не задан | нет |
| `TOKEN_KEEPALIVE_HOURS` | каденция keep-alive-рефреша (не потерять refresh_token на 180-й день) | нет (дефолт 24, диапазон 1–168) |
| `NUXT_LOG_LEVEL` | уровень логов (`info`/`warning`/`error`) | нет |
| `DOMAIN` / `LETSENCRYPT_EMAIL` | домен + email для TLS (в `.env.prod`) | да в проде |

> Слабый/пустой `DASHBOARD_AUTH_SECRET` в проде → дашборд `503` (fail-closed, это защита).
> Node.js **≥22**, **pnpm 10.33** (corepack).

### Демо-режим

```bash
cp .env.example .env; openssl rand -hex 32   # свой секрет
DASHBOARD_DEV_OPEN=1 docker compose up --build app
```
Открыть: опрос `http://localhost:3000/s/csat_postdeal`; дашборд `…/d/csat_postdeal`; health
`…/api/health` → 200. Без Docker: `pnpm install && pnpm build && DASHBOARD_DEV_OPEN=1 node .output/server/index.mjs`.

### Прод-режим (авто-CD)

Мерж в `main` → GitHub Actions собирает образ в GHCR (`ghcr.io/bx-shef/polls:latest`) → watchtower
подтягивает (~5 мин). TLS — Let's Encrypt через общий nginx-proxy (сеть `proxy-net`). Пакет GHCR сделать
**public** (иначе первый `make prod-up` требует `docker login`). Деплой-файлы (`/home/bitrix/polls/`):

```bash
BASE=https://raw.githubusercontent.com/bx-shef/polls/main
curl -fsSL $BASE/docker-compose.prod.yml       -o docker-compose.prod.yml
curl -fsSL $BASE/docker-compose.nginxproxy.yml -o docker-compose.nginxproxy.yml
curl -fsSL $BASE/Makefile                        -o Makefile
curl -fsSL $BASE/.env.prod.example               -o .env.prod   # DOMAIN + секреты
```
Запуск: чистый сервер — `make init-network init-nginxproxy` (нужен `LETSENCRYPT_EMAIL`) → `make prod-up`;
сервер с готовым nginx-proxy — только `make prod-up`. Затем A-запись `DOMAIN` → сервер (nginx-proxy
выпустит TLS). Ручной редеплой — `make prod-redeploy`; логи — `make prod-logs`. Проверка:
`https://DOMAIN/api/health` → 200. Прод-БД: сначала `pnpm migrate up` (миграции идемпотентны).

### Ручной прогон режима приложения Bitrix24

**Предусловия:** прод по HTTPS (cookie `polls_portal` = `Secure; SameSite=None; Partitioned`); локальное
приложение (scopes `crm`,`user_brief`,+`bizproc`,`im`; **Installation URL** → `https://DOMAIN/api/b24/install`,
**Application URL** → страница приложения); секреты `DASHBOARD_AUTH_SECRET`(≥32), `NUXT_BITRIX_TOKEN_KEY`(≥64 hex).

> ⚠ **Условие сквозного прогона:** резолвер `domain → member_id` — no-op **только без `DATABASE_URL`**
> (dev/MemoryStore) → `POST /api/b24/session` = 401. В прод-стеке (`DATABASE_URL` задан) `setPortalResolver`
> подключается **автоматически** (`server/utils/api.ts`), а таблицу `portal` наполняет установка.
> Остаётся **живой прогон** на портале.

**Сегодня (dev, без `DATABASE_URL`):** демо целиком; рендер виджетов `/b24/deal-widget`·`task-widget`·`dashboard`;
`/api/health` за TLS → 200. **Полный прогон (прод-стек с Postgres):** установка (робот + плейсменты, сверить
`placement.list`) → виджет сделки (`deal-invite`) → прохождение (`/s/:key`, повтор → 409) → виджет задачи
(`task-invite`) → дашборд (только свой `portalId`) → авто-триггер (#17).

### Частые проблемы

| Симптом | Причина | Решение |
|---|---|---|
| Дашборд `503` | нет/слабый `DASHBOARD_AUTH_SECRET` в проде | задать ≥32, либо демо `DASHBOARD_DEV_OPEN=1` |
| Дашборд `401` | нет валидной сессии портала | пройти handshake из фрейма (`/api/b24/session`) |
| Установка → «проверка привязки портала не пройдена» (`403`) | authoritative `member_id` ≠ заявленному / `invalid_grant` (member_id-binding) | защита: чужой/подделанный грант отвергнут; легитимная — переустановить (свежий грант); лог `b24_install_member_reject` |
| Установка → «сервер авторизации Bitrix24 недоступен» (`503`) | не смог рефрешнуть токен (сеть/5xx/**429** на `oauth.bitrix.info`) | транзиент — повторить; проверить исходящий доступ к `oauth.bitrix.info` |
| Установка → «интеграция не сконфигурирована» (`503`) | нет `NUXT_B24_CLIENT_ID/SECRET`, БД или ключа шифрования | задать OAuth-креды + `DATABASE_URL` + `NUXT_BITRIX_TOKEN_KEY` (fail-closed) |
| Установка → «слишком много попыток установки» (`429`) | rate-limit install (20/60с; за nginx — общий bucket) | подождать ~минуту; лог `b24_install_ratelimited` |
| Установка → «недопустимый домен портала» (`400`) | домен не прошёл allowlist `*.bitrix24.<tld>` (SSRF-гард) | облачный портал не должен ловить; self-hosted/box не поддержан; лог `b24_install_bad_domain` |
| Данные пропали после рестарта | нет `DATABASE_URL` → MemoryStore (демо) | задать `DATABASE_URL` (прод-compose уже разводит Postgres) |
| Cookie не ставится во фрейме | нет HTTPS | включить TLS (`Secure; SameSite=None; Partitioned`) |
| `/api/b24/session` → `401` всегда | нет `DATABASE_URL` → резолвер no-op (dev) | задать `DATABASE_URL` — `setPortalResolver` подключится сам |

> **Исходящая зависимость установки.** С member_id-binding обработчик `/api/b24/install` при **каждой**
> установке делает исходящий POST-рефреш на **`oauth.bitrix.info/oauth/token/`** (проверка authoritative
> `member_id`). Сервер обязан иметь исходящий HTTPS к этому хосту; при блокировке firewall'ом установка
> стабильно отдаёт `503`.

---

## Наблюдаемость

Ядро (`src/obs/`) — zero-dep (конвенция «только `zod` в prod»):

- **`Logger`** (`debug/info/warn/error(msg, fields?)` + `child`), **`createJsonLogger`** (1 строка JSON;
  уровень из `opts.level` → env `LOG_LEVEL`/`NUXT_LOG_LEVEL` → `info`; `time`/`level`/`msg` зарезервированы;
  sink инжектируется), **`nullLogger`**, **`errInfo(e)`** → `{name,message,stack}`.
- **`redact()`** — маскирует по имени ключа (token/secret/password/authorization/cookie/signature/nonce/…);
  защита структуры ([Circular]/[Truncated]/усечение). ⚠ по ключу, не по значению — секреты в тексте
  `message`/`stack` не маскируются (креды в строке подключения вычищает `errInfo`).
- **`GET /api/health`** = `IStore.ping()` → 200/503 (деталь в лог `health_ping_failed`, наружу не утекает);
  публичный, НЕ throttled; результат кэшируется `healthCacheMs` (default 1000мс, анти-DoS на пул БД).
- **Корреляция:** `x-request-id` (генерит `server/node.ts`) + строка лога `request`
  (`{requestId,method,path,status,durationMs,ip}`; 5xx→error, 4xx→warn).
- **`installProcessHandlers`** — unhandled → лог + `onFatal`/exit (opt-in; точка Sentry).

**Остаётся (слой деплоя, #5/#15):** адаптеры `Logger`→Pino / `onFatal`→Sentry; живой `/health` за
reverse-proxy с реальным `pg.Pool`; метрики (Prometheus) + OTel-трейсы поверх `x-request-id`-seam;
политика `ip`/PII (за прокси это X-Forwarded-For — хэшировать/опускать/зафиксировать правовое основание).

---

## Дизайн (b24ui)

Два визуальных режима: **контур A** (публичный опрос) — айдентика прототипа (крупная типографика,
**индиго-акцент**, тёплый фон); **контур B** (дашборд) — нативная тема b24ui `air-*` (без индиго).
Полный обезличенный референс UX — только в этом документе (прототип-источник недоступен).

### Палитра прототипа (контур A)

| Токен | HEX | Назначение |
|---|---|---|
| `--page` | `#FBFBF9` | фон (тёплый off-white) |
| `--card` | `#FFFFFF` | карточки/опции |
| `--ink` / `--muted` / `--faint` | `#15161A` / `#6B6F76` / `#9A9DA3` | текст (осн./вторич./хинты) |
| `--line` / `--line-soft` | `#E7E7E2` / `#F0F0EC` | границы |
| **`--accent`** / `--accent-ink` | **`#5B5BD6`** / `#4A45C9` | акцент (индиго) / hover |
| `--accent-soft` / `--accent-line` | `#EEEEFB` / `#C9C8F2` | фон выбранной опции / граница «Другое» |
| `--success` | `#1F9D6B` | финальный бейдж |
| `--error` / `--error-soft` | `#D6453B` / `#FBEDEC` | ошибки / тост |

**Маппинг в b24ui:** акцент → `air-primary` (в контуре A primary-токен переопределён на индиго; в B —
штатный); успех → `air-primary-success`; ошибка → `air-primary-alert`; выбор — заливка `variant="card"`.
Типографика: `--font-display` **Unbounded** (заголовки/номера), `--font-ui` **Inter** (тело),
`--font-mono` **JetBrains Mono** (мета). Радиусы: карточка 18 / опция 13 / кнопка 12 / пилюля 999;
`--maxw: 640px`; рейл `--rail-w: 38%`.

### Брейкпоинты

| Ширина | Раскладка |
|---|---|
| ≥1280px | десктоп: 2 колонки (рейл 38% + сцена), хинты клавиш, `columns:2` → 2 колонки |
| 1024–1280px | то же, рейл ~34% |
| ≤1023px | мобайл: 1 колонка, рейл скрыт, sticky-хедер + нав `fixed bottom-0` (safe-area), `columns:2`→1, кнопки `block` |

### Компоненты и состояния

`single`→`B24RadioGroup variant="card"`; `multi`→`B24CheckboxGroup variant="card"`; `text`→
`B24Textarea :maxlength="2000"`; «Другое»→`B24Input :maxlength="80"`+счётчик; CTA→`B24Button
color="air-primary" size="xl"`; прогресс `B24Progress`; ошибка `B24FormField error`/`B24Alert
air-primary-alert`; тост `B24Toast`; «Спасибо» `B24Alert air-primary-success`. Дашборд: `B24Dashboard*`,
`B24Page*`, `B24Table` (TanStack), графики `@unovis/vue`. Иконки — `@bitrix24/b24icons-vue`.
Состояния под гейтом: пусто (=404)/ошибка/submit-error/hover-focus. Уважается `prefers-reduced-motion`.
**Тёмная тема:** опрос фиксируем светлым (как прототип); в приложении добавлена по `prefers-color-scheme`
(`@nuxtjs/color-mode`, класс `.dark`) + ручной тоггл `B24ColorModeButton`. `@media print` — для будущего
экрана-результата (#18).

---

## Визуальный гейт

Детерминированная верификация **render → screenshot → сверка с эталоном** на **живых маршрутах**
(Playwright): `webServer` поднимает собранное приложение (`pnpm build && node .output/server/index.mjs`,
loopback, готовность по `/api/health`), снимает реальный SSR-рендер на демо-сиде.

- **48 эталонов** = 8 поверхностей (5 контур A: intro/survey/thanks/error/submit-error + 3 контур B:
  дашборд/фильтр-по-версии/дашборд-ошибка) × 3 брейкпоинта × 2 темы (light/dark). Плюс 2 поведенческих
  теста без скриншота × 6 проектов (брейкпоинт×тема) → **60 прогонов** гейта. Admin-UI (`/admin/*`) пока НЕ в гейте.
- **Файлы:** `playwright.config.ts`, `test/visual/screens.visual.ts` (A), `dashboard.visual.ts` (B),
  `__screenshots__/**/*.png`, Stop-хук `.claude/hooks/visual-gate.sh`.
- **Команды:** `pnpm test:visual` (прогон) · `pnpm test:visual:update` (обновить эталоны — глазами
  сверить `git diff .png` перед коммитом) · `pnpm visual:install` (chromium; в удалённой среде
  предустановлен). Держать сервер: `PORT=3030 DASHBOARD_DEV_OPEN=1 pnpm preview` (порт РОВНО 3030).
- **Инвариант:** гейт-тесты НЕ пишут в общий стор (thanks/submit-error **мокают** `/api/submit`).
- **Приватность:** скриншоты — только dev/staging с мок-данными; рендер живого портала не коммитим.
- **Stop-хук** (`.claude/settings.json`): узкий триггер (только тронутые UI-поверхности), мягкая
  деградация без браузера, блок только на реальном провале. В CI пока НЕ подключён — **#41** (нужен
  закреплённый контейнер рендера).
- ⚠ Дашборд под auth-гейтом: при `reuseExistingServer` **`DASHBOARD_DEV_OPEN=1` обязателен**.
  Не запускать `pnpm test:visual` параллельно (две сборки Nuxt конфликтуют).

---

## Ключевые решения

Короткое «почему так» (нетривиальные технические решения фиксируются здесь):

- **Brain-first** — продаём решения, не анкеты: AI превращает ответы в число + причину + действие.
- **Локальное приложение (1 портал = 1 инстанс = своя БД)** — проще изоляция и приватность; tenant-ключ
  `portalId`.
- **Схема — единый источник истины (zod)** — TS-тип и runtime-валидация из одних схем.
- **Иммутабельные версии + стабильные ключи** — сопоставимость аналитики между версиями; пин версии на
  приглашении.
- **`invitationPolicy`/презентация — version-frozen** (#21/#25) — ответ интерпретируется по версии, на
  которой собран.
- **Подавление малых N в слое чтения** — анонимность нельзя обойти, читая агрегат напрямую.
- **AES-256-GCM с `kid` в blob** — форвард-совместимость ротации ключа без миграции данных.
- **Logger интерфейсо-зависим, не вендоро** — zero-dep ядро, прод подменяет Pino/Sentry инъекцией.
- **Публичная проекция версии — в HTTP-хендлере** (`toPublicVersion`, без `invitationPolicy`) — CRM-
  конфигурация наружу не утекает; тип `Omit<…>` гейтит будущие чувствительные поля компилятором.
- **HTTP-кэш `no-cache` + ETag** (#30) — смена текущей версии видна сразу; экономию даёт 304-без-тела.
- **Граница `~core` форсится своим гардом, не ESLint** (`check:boundary`) — инфру не изобретаем без нужды.
- **OAuth-lifecycle hardening (миграция 0004)** — тумбстоун + UPDATE-only refresh + keep-alive-порог +
  member_id-binding + SSRF-фикс регекса + rate-limit install (см. раздел Безопасность).
- **`clientEndpoint` всегда деривится из `domain`** — присланный/грант-endpoint как host не используются
  (SSRF); `domain` валидируется allowlist до REST.
- **Стек Bitrix24:** `@bitrix24/b24jssdk ^2.0` (тонкий слой на `actions.v2.call.make`) + `@bitrix24/b24ui-nuxt ^2.9`.
- **Dependabot + гейт образа на PR; без авто-мержа** (мержит владелец); сторонние actions запиннены на SHA.

---

## Дальнейшая работа

Открытые задачи — [`issues.md`](./issues.md). Приоритеты по фазам:

- **Фаза A (хвост)** — **живой install-smoke** на тест-портале (page+event → токен captured → uninstall
  CLEAN=1/0). Код закрыт.
- **Фаза B 🟠** — **живая верификация** прод-стека (PgStore разведён в коде+compose — подтвердить
  персистентность + handshake) + **#49** tenant-фильтр мульти-портала; edge-security (CSP/HSTS/
  анти-брутфорс, `server/middleware/`, `APP_EDGE_SECURITY` DEFAULT-OFF — нужна визуальная сверка CSP в
  iframe); CI→publish gate.
- **Фаза C 🟠** — **#15** OpenTelemetry (app-slice DEFAULT-OFF) + адаптеры Pino/Sentry.
- **Фаза D 🟠🟡** — **#17** авто-триггер `ONCRMDEALUPDATE` (эндпоинт `/api/b24/deal-update` + `event.bind`
  сделаны в коде; остаётся живой smoke + доставка ссылки); **#18** результат → таймлайн сделки + просмотр/PDF; рейтинг приложения + виджет
  обратной связи (UI по b24ui).
- **Фаза E 🟡** — **#4** общий стор анти-абьюза (Redis/PG) + `X-Forwarded-For` для мульти-инстанса;
  AI-разбор ответов (`answer_insight`).
- **Follow-up'ы (мелкие):** явный whitelist облачных TLD Bitrix + валидация `serverEndpoint`
  (остаточный SSRF); `UNIQUE(portal.domain)` (полное domain-poisoning); store-side TTL-кэш `currentVersion`
  (остаток #30); товары для `task-invite`/lead/смарт-процесса + группировка free-form по `productName`;
  визуальный гейт `/admin/*`; PII-редакция/erasure на HTTP-слое (#31); кнопка «очистить период».

---

## Рабочий процесс (задача → PR → review → мерж)

- **Ветка** `claude/<slug>` от свежего `main`; одна задача — одна ветка; скоуп PR маленький (один слой).
  «Не в скоуп» → выносим в ISSUE.
- **Тело PR:** «простыми словами» → «что внутри» → «проверка» (`pnpm check` зелёный) → «дальше».
- **Ревью-ритуал:** 5 агентов в фоне (документалист / программист / тестировщик / security / CTO;
  каждый держится **диффа**) + сводный отчёт с severity **blocker / major / minor / nit**. Правки — в
  тот же PR, потом снова `pnpm check`.
- **Гейт мержа:** `pnpm check` зелёный (typecheck + тесты с покрытием ≥85%, по факту ~100% + `verify`),
  CI success, clean working tree, 0 отставания от `main`.
- **Мерж:** squash + курированное тело + штампы → удалить ветку. Roadmap-issue закрывается, когда закрыт
  весь скоуп фазы. Решения фиксируются в этом документе (§Ключевые решения).
- **CI:** `ci.yml` (typecheck ядра + граница `~core` + `typecheck:app` vue-tsc + тесты с покрытием +
  verify), `docker-build.yml` (сборка образа на PR без публикации), `docker-publish.yml` (GHCR на push
  в `main`). Визуальный гейт — Stop-хук (в CI — #41).

---

## Глоссарий

- **Контур A** — публичный анонимный сбор ответов (Интро/Опрос/Спасибо + `/api/session`,`/api/submit`),
  без Bitrix24-авторизации. **Контур B** — закрытый дашборд результатов внутри Bitrix24.
- **`SurveyFill`** — framework-agnostic «мозг» прохождения (навигация/deep-link, валидация шага,
  single/multi+exclusive, «Другое», persist; без DOM/Vue).
- **Версия-снимок (`CompiledVersion`)** — иммутабельный результат `compile()`; ответ пинится на номер версии.
- **`question_key` / `option_key`** — стабильные ключи; якоря сопоставимости между версиями.
- **Invitation** — одноразовое приглашение (single-use токен); при submit токен → снимок `CrmContext`
  (replay→409, unknown→403, чужой пин→409).
- **`CrmContext`** — снимок контекста из CRM (сделка/услуга/клиент/направление), привязан к ответу.
  **`CrmContext.dealStageId`** — обобщённый триггер-ключ (сделка `STAGE_ID`, лид `STATUS_ID`, СП `stageId`).
- **`exclusive`** — взаимоисключающий вариант в `multi` («ничего/нет»).
- **Подавление малых N** — агрегаты не отдаются при выборке < `ANONYMITY_THRESHOLD` (=5).
- **`portalId` / `member_id`** — tenant-ключ (1 портал = 1 инстанс = своя БД); численно совпадают.
- **Handshake фрейма** — обмен `BX24.getAuth` на подписанную сессию (cookie `polls_portal`); SSRF-allowlist
  + сверка `member_id`.
- **install-poisoning** — подделка установки с чужим `member_id`; **member_id-binding** — защита (§Безопасность и инварианты).
- **`triggerStages`** — денормализованные стадии-триггеры (GIN, `surveysTriggeredBy`, #22).
- **`entityType`** — тип сущности-датчика (deal/lead/spa/contact/company/task; для `spa` обязателен
  `spaEntityTypeId`; `task` — только ручной запуск).
- **`invitationPolicy`** — политика приглашений (`entityType`/`spaEntityTypeId`/`triggerStages`/
  `channelOrder`), version-frozen (#21).

---

## Команды

```bash
pnpm check        # всё разом: typecheck + test (покрытие) + verify
pnpm typecheck    # tsc --noEmit (ядро)
pnpm test         # vitest;  pnpm test:cov — с покрытием (порог 85%, CI гейтит)
pnpm verify       # печатает И сверяет assert'ами итог на 4 уровнях (src/demo/seed.ts)
pnpm check:boundary   # гард границы ~core (клиент не тянет server-only ядро)
pnpm typecheck:app    # vue-tsc app/+server/ (перед — pnpm nuxt:prepare)
pnpm serve        # демо HTTP-сервер на MemoryStore+seed (PORT=8080)
pnpm migrate up   # применить миграции БД (node-pg-migrate; DATABASE_URL)
pnpm dev          # Nuxt-приложение в dev (HMR);  pnpm build / pnpm preview
pnpm test:visual  # визуальный гейт (Playwright);  test:visual:update — обновить эталоны
```

Для проверок предпочитай `scripts/check.sh` / `check.ps1` — один запуск ставит зависимости и прогоняет всё.

---
*Последнее ревью: 2026-07-23.*
