# Карта issue

> Свод открытых issue со статусом и зависимостями — для быстрого онбординга сессии.
> Roadmap-issue (крупные фазы) остаются открытыми, пока не закрыт весь скоуп фазы.
>
> ✅ **Сверено с живым GitHub 2026-07-24** (`mcp__github__list_issues`, repo `bx-shef/polls`,
> 12 открытых после закрытия #30/#34/#39 и заведения #118). Освежать в начале сессии — issue
> двигаются. При расхождении источник истины — **живой GitHub**: правим этот файл под него, а не наоборот.

## Открытые (live GitHub, 12)

| # | Тема | Слой | Статус | Осталось / зависит |
|---|---|---|---|---|
| #4 | Серверный анти-абьюз: общий стор nonce/лимитов/приглашений (мульти-инстанс), `X-Forwarded-For` | деплой | ядро для 1 инстанса ✅ (#11); durable-идемпотентность ответа ✅ (0003) | общий стор (Redis/PG) → мульти-инстанс; доверие XFF — на адаптере деплоя; связь `invitation_id` с #17 |
| #10 | Read-API хвост: PII-редакция/erasure на HTTP-слое + SQL-`npsTrend` | store/api | основное ✅ (#8/#9); `GET /api/survey/:key/current` ✅ (#29); ETag/условный GET ✅ (#114); SQL-`npsTrend` ✅ | остался только PII-хвост → #31 |
| #13 | Визуальная верификация UI: Playwright + `Stop`-хук + регресс-тесты | UI | инфра ✅ — гейт на **живых** маршрутах (`webServer` → `.output`, 48 эталонов light/dark × брейкпоинты) | CI-интеграция → #41; доп-состояния → #34 |
| #15 | Наблюдаемость на деплое: `Logger`→Pino / `onFatal`→Sentry, метрики/OTel, ip-политика | деплой | ядро ✅ (#5, PR #14) | чистый деплой-слой: адаптеры Pino/Sentry + метрики/OTel + политика `ip` (PII) |
| #17 | Invitation binding `ONCRMDEALUPDATE` + вшивание `invitationPolicy` в схему/PgStore | bitrix24 | ядро + `products` ✅ (#115); **Nitro-эндпоинт `/api/b24/deal-update` + `event.bind` при install ✅ в коде** (`runDealUpdate`: bracket-форма → парс → сверка `application_token` → `crm.deal.get` токеном портала → `surveysTriggeredBy` → приглашения; под тестами) | остаётся: **живой smoke** на портале; **дедуп/детекция перехода** — `ONCRMDEALUPDATE` бьёт на ЛЮБОЙ апдейт сделки, не на смену стадии → **БЛОКЕР перед доставкой** (дедуп по `dealId+surveyKey+stage`); доставка ссылки (email/SMS); робот-эндпоинт `/api/b24/robot` (dangling); обогащение имён |
| #18 | Результат анкеты → таймлайн сделки (`crm.activity.*`) + result-viewer (HTML, печать/PDF) | bitrix24 | открыт | симметрия к #17; зависит от OAuth (#3 ✅), binding-слоя (#17), PII (#10/#31) |
| #31 | PII-редакция на HTTP-границе (ляжет с read-эндпоинтом ответов контура B) | store/api | открыт | нет публичного read-ответов → нет калл-сайта; не плодим dead code (ждёт read-surface #18/#49) |
| #41 | Wire `pnpm test:visual` в CI (закреплённый рендер-контейнер) | UI/CI | открыт — гейт пока **agent-side** (Stop-хук) | нужен pinned chromium-контейнер (эталоны env-чувствительны); отдельный CI-job, не в `pnpm check` |
| #45 | Контур A: ручной тоггл темы (light/dark/system) + согласование color-mode storage | UI | открыт — авто по `prefers-color-scheme` работает | UI-тоггл (`B24ColorModeButton`) + свести `storageKey` (b24ui vs `@nuxtjs/color-mode`); тоггл под гейт |
| #47 | Дашборд контура B: auth-гейтинг + tenant-изоляция (`portalId`) под OAuth Bitrix24 | bitrix24/деплой | гейт `requirePortalSession` + handshake фрейма + боевой резолвер `setPortalResolver` ✅ (в коде) | per-portal tenant-фильтр стора — #49 (сейчас single-tenant); живой прогон |
| #49 | Дашборд контура B: SQL-агрегация (PgStore) + rate-limit + per-bin k-анонимность + **tenant-изоляция по `portalId`** | store/api | rate-limit ✅; pg-Pool + `setPortalResolver` **сделаны в коде** (`server/utils/api.ts`) | открыто: per-portal tenant-фильтр (store-factory `member_id → scoped PgStore`, сейчас single-tenant), SQL-агрегат дашборда (сейчас in-memory над сидом), ужесточение подавления малых bin |
| #118 | Визуальный гейт: интеракционные состояния (hover/focus/disabled) + `/admin/*` | UI | открыт — узкий follow-up от закрытого #34 | эталоны интеракционных состояний контура A + admin-экраны под гейт (light/dark × брейкпоинты) |

## Предложения (бэклог, не заведены как GitHub-issue)

> Идеи из сессий, не оформленные отдельными issue. Держим как список кандидатов;
> заводить в GitHub при взятии в работу. Детали процесса — [`docs/process.md`](process.md)
> §Управление опросами; решения — [`docs/project-map.md`](project-map.md) §Ключевые решения.

| Тема | Слой | Статус |
|---|---|---|
| Админ-UI создания/редактирования опросов (конструктор поверх `SurveyDraft`/`publish`) | app/api | ✅ реализовано (список + конструктор: add/remove/reorder вопросов/опций, тип/метрика/баллы); остаток — drag-and-drop мышью + юнит-тесты composable |
| Действие «очистить данные за период» в дашборде/админке | app/store | предложен (сейчас вручную SQL по `response`, tenant-scoped; нужен UI-action) |
| Доп. точки встройки Bitrix24 (вкладка сделки `CRM_DEAL_DETAIL_TAB`, лиды/контакты, `LEFT_MENU`, imbot-доставка) | bitrix24 | предложен (поверх готового `client.ts`/`placement.bind`) |
| Прогрессивное раскрытие дашборда (первый экран = NPS/CSAT + топ-срезы; глубокие срезы по клику) | app | предложен (ядро всё считает — вопрос подачи) |
| Мульти-сущность: датчик для lead/spa/contact/company (`<entity>ToCrmContext` + плейсменты) | bitrix24 | предложен (модель готова: `entityType`/`spaEntityTypeId` в схеме; боевой триггер пока `deal`) |
| Триггер по задаче (`task`): автотриггер `ONTASKUPDATE` по статусу | bitrix24 | частично (ручной запуск ✅; автотриггер — нет: у задачи нет `stageId` воронки → нужен механизм по STATUS) |
| `surveysTriggeredBy` мульти-сущность: составная фильтрация `(entityType, stageId)` + денормализация в колонки | store | предложен (сейчас GIN по `trigger_stages` для deal; namespace стадий spa другой) |
| `/admin/*` в визуальный гейт #13 (список + конструктор; light/dark × брейкпоинты) | UI | предложен (экраны сверены глазами, эталоны не сняты) |
| Рефактор `CrmContext.dealStageId` → `entityStageId` (обобщённый триггер-ключ) | domain/store | специфицирован, БЛОКЕР: живая БД (поле в JSONB `response.context` → нужна data-миграция + read-совместимость) |
| Выбор опроса по типу сущности: UI-маппинг `entityType → surveyKey` (без хардкода env) | app/store | env-слой ✅ (`survey-routing.ts`); UI-маппинг — предложен |
| Проверка прав пользователя на задачу/сделку в `*-invite` (виджет) | bitrix24 | предложен (сверять `responsible`/участника с `frame.member_id`→userId) |
| Binding-слой мульти-сущности: `event.bind` на `ONCRM<ENTITY>UPDATE` → диспетчер `entityToCrmContext` | bitrix24 | ЯДРО ГОТОВО (диспетчер + `entityGet` под тестами); остался эндпоинт + `event.bind` (живой портал) |

## Закрытые (контекст)

- **#3** — OAuth Bitrix24 + invitation-flow ядро (AES-256-GCM, refresh, startup-guard).
- **#5** — наблюдаемость ядро (логгер с редакцией, `/api/health`, process-хуки). Остаток — #15.
- **#6** — раннер миграций `node-pg-migrate` (`pnpm migrate up`).
- **#7** — read-API / PgStore (CRUD, tenant-изоляция, keyset-пагинация, SQL-агрегация).
- **#11** — HTTP-слой `/api/session`+`/api/submit` с анти-абьюзом (ядро #4).
- **#16** — invitation-flow ядро-рантайм (`Invitation` + проброс в submit).
- **#21** — `invitationPolicy` version-frozen (решение — project-map.md §Ключевые решения).
- **#22** — денормализация `triggerStages` + `IStore.surveysTriggeredBy` (GIN).
- **#24** — `SurveyFill` («мозг» прохождения опроса, контур A) — в `src/client`, под тестами.
- **#25** — презентационные поля (`intro`/`thanks`/`blockLabels`) в схеме, version-frozen (PR #28).
- **#29** — публичный `GET /api/survey/:key/current` (проекция версии без CRM-конфигурации).
- **#30** — `ETag` + условный GET (304) для `/api/survey/:key/current` (PR #114); TTL-кэш признан избыточным.
- **#34** — визуальный гейт fixture → живые маршруты (фикстуры удалены, 48 эталонов); остаток → **#118**.
- **#36** — CI-typecheck `app/` + энфорс границы `~core` (`pnpm check:boundary` + `typecheck:app`).
- **#39** — визуальный гейт `/s/:key` на живом SSR-рендере (перекрыт текущим гейтом).
- **#95** — миграция deprecated `callMethod` → `actions.v2.call.make` (PR #97).
- **Фаза A OAuth-lifecycle** — устойчивость + тумбстоун + keep-alive + uninstall + member_id-binding +
  SSRF-allowlist + rate-limit install (PR #109–#113), закрыта **по коду**; остаётся живой install-smoke.

---
*Последнее ревью: 2026-07-24.*
