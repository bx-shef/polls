# Карта issue

> Свод открытых issue со статусом и зависимостями — для быстрого онбординга сессии.
> Roadmap-issue (крупные фазы) остаются открытыми, пока не закрыт весь скоуп фазы.
>
> ✅ **Сверено с живым GitHub 2026-06-19** (`mcp__github__list_issues`, repo
> `bx-shef/polls`). Освежать в начале сессии — issue двигаются. Ниже — отслеживаемые
> открытые issue; `#47`/`#49` заведены под дашборд контура B (полный ре-синк с API
> отложен — лимит в этой сессии).

## Открытые

| # | Тема | Слой | Статус | Зависит / блокирует |
|---|---|---|---|---|
| #25 | Презентационные поля опроса (`intro`/`thanks`/`blockLabels`) в схеме — до Nuxt-слоя | domain | открыт | **блокер экранов** intro/thanks; version-frozen (как #21) |
| #18 | Результат анкеты → таймлайн сделки (`crm.activity.*`) + result-viewer (HTML, печать/PDF) | bitrix24 | открыт | симметрия к #17; зависит от OAuth (#3 ✅), PII (#10) |
| #17 | Invitation binding `ONCRMDEALUPDATE` + вшивание `invitationPolicy` в схему/PgStore | bitrix24 | открыт (ядро парс/верификации/маппинга сделано) | `invitationPolicy` version-frozen (#21), `triggerStages`+`surveysTriggeredBy` (#22), invitation-flow (#16). Ядро триггера: `src/bitrix24/deal-event.ts` (`parseDealUpdateEvent` + `verifyApplicationToken` анти-форджери + `dealToCrmContext` из `crm.deal.get`) под тестами. Осталось (живой портал): эндпоинт `POST /api/b24/deal-update` → верификация → `crm.deal.get` токеном портала → `surveysTriggeredBy` → создание приглашений (идемпотентно по deal+survey); регистрация `event.bind` + хранение `application_token` при OAuth-установке; обогащение имён (company/category/user.get); живой smoke. **Триггеры:** робот `bizproc.robot.add` (зависит от тарифа) + для охвата на ВСЕХ тарифах — плейсменты `placement.bind`: `CRM_DEAL_DETAIL_ACTIVITY` (виджет запуска опроса в карточке сделки, `PLACEMENT_OPTIONS={ID}`) и `CRM_ANALYTICS_MENU` (дашборд в меню CRM-аналитики). Ядро: `install.ts` (`surveyRobotParams`/`surveyPlacements`/`parsePlacementDealId`/`handleInstall`), `trigger.ts` (`handleDealTrigger`/`dealIdFromDocumentId`) — под тестами. Симметрия результат→CRM — `crm.automation.trigger.add` (#18). REST — `client.ts` (b24jssdk). Осталось: Nitro-эндпоинты `/api/b24/install`+`/api/b24/robot` + Vue-виджеты (`/b24/deal-widget`,`/b24/dashboard`) с handshake #47 + боевой B24OAuth. Связан с #4 |
| #15 | Наблюдаемость на деплое: `Logger`→Pino / `onFatal`→Sentry, метрики/OTel, ip-политика | деплой | открыт | ядро #5 ✅; чистый деплой-слой |
| #13 | Визуальная верификация UI: Playwright + `Stop`-хук + регресс-тесты | UI | инфра ✅ (фикстура-заглушка) | машинерия доказана end-to-end; фикстуры → маршруты с приходом экранов; CI-интеграция позже (`docs/visual-gate.md`) |
| #31 | PII-редакция на HTTP-границе (ляжет с read-эндпоинтом ответов контура B) | store/api | открыт | нет публичного read-ответов → нет калл-сайта; не плодим dead code |
| #10 | Read-API хвост: `GET /api/survey/:key/current` ✅ (#29), SQL-`npsTrend` ✅, PII-редакция → #31 | store/api | открыт (хвост → #31) | основное сделано; остался только PII-хвост (#31) |
| #4 | Серверный анти-абьюз: общий стор nonce/лимитов/приглашений (мульти-инстанс), `X-Forwarded-For` | деплой | ядро для 1 инстанса ✅ (#11); durable-идемпотентность ответа ✅ (0003) | общий стор → мульти-инстанс; связь `invitation_id` с #17 |
| #47 | Дашборд контура B: auth-гейтинг + tenant-изоляция (`portalId`) под OAuth Bitrix24 | bitrix24/деплой | открыт (гейт + ядро handshake сделаны) | `requirePortalSession` + подписанная сессия (`src/api/session.ts`) — fail-closed в проде. Ядро handshake фрейма (`src/bitrix24/frame.ts`: SSRF-allowlist + анти-cross-tenant + минт сессии) + боевой `authenticate` (`src/bitrix24/authenticate.ts`: `app.info` + резолв `member_id` из install-маппинга, под тестами) + эндпоинт `POST /api/b24/session` (cookie `polls_portal` `SameSite=None; Secure; Partitioned`, fail-closed; smoke `pnpm build`+curl). Резолвер `domain → member_id` сделан ядром (`resolveMemberIdByDomain`, pglite-тесты) — осталось подставить его в `setPortalResolver` через pg-Pool + tenant-фильтр стора (нужен Nitro-pg-Pool по `DATABASE_URL`) — слой #49/#6 |
| #49 | Дашборд контура B: SQL-агрегация (PgStore) + rate-limit + per-bin k-анонимность + **tenant-изоляция стора по `portalId`** | store/api | открыт (заведён в сессии) | rate-limit `/api/b24/session` сделан (`allowB24Session`, 10/60с/IP); сейчас агрегат in-memory над сидом. **TENANT-ГЕЙТ мульти-портала:** `useStore()` single-tenant (один PgStore) — handshake/deal-invite/триггер подтверждают `portal.portalId`, но стор НЕ scoped по нему (для одного портала безопасно, для нескольких — cross-tenant). Нужен store-factory `member_id → portal.id → scoped PgStore` (помечено в `server/api/b24/deal-invite.post.ts`/`trigger.ts`). Также: SQL-агрегат + ужесточение подавления |
| NEW | Админ-UI создания/редактирования опросов (визуальный конструктор поверх `SurveyDraft`/`publish`) | app/api | ✅ реализовано (список #83/#86 + конструктор #86+фаза5: add/remove/reorder вопросов и опций, тип/метрика/баллы) | остаток: drag-and-drop мышью + юнит-тесты логики (composable). См. `survey-management.md` |
| NEW | Действие «очистить данные за период» в дашборде/админке | app/store | предложен | сейчас вручную SQL по `response` (tenant-scoped); нужен UI-action поверх. См. `survey-management.md` |
| NEW | Доп. точки встройки Bitrix24 (вкладка сделки `CRM_DEAL_DETAIL_TAB`, лиды/контакты, `LEFT_MENU`, imbot-доставка) | bitrix24 | предложен | поверх готового `client.ts`/`placement.bind`, без переделки ядра. См. `survey-management.md` |
| NEW | Прогрессивное раскрытие дашборда (первый экран = NPS/CSAT + топ-срезы; глубокие срезы — по клику) | app | предложен | ядро всё считает — вопрос подачи; см. рефлексию в `survey-management.md` |
| NEW | Мульти-сущность: датчик опроса для lead/spa/contact/company (`<entity>ToCrmContext` + плейсменты их карточек + обобщить `deal-event`/виджет) | bitrix24 | предложен (модель готова: `entityType`/`spaEntityTypeId` в схеме) | боевой триггер пока только `deal`; `spa` требует `crm.item.get` + tenant-scope (IDOR-риск, security-ревью). См. фазы в `survey-management.md` |
| NEW | Триггер по задаче (`task`): автотриггер `ONTASKUPDATE` по статусу (у задачи нет `stageId` воронки) | bitrix24 | частично (ручной запуск ✅, автотриггер — нет) | **Ручной запуск СДЕЛАН** (плейсмент `TASK_VIEW_SIDEBAR` + виджет `app/pages/b24/task-widget.vue` + эндпоинт `server/api/b24/task-invite.post.ts` + `taskToCrmContext`/`parseTaskCrmBindings` из `crmItemIds`/`ufCrmTask` + `taskGet`, под тестами). Осталось: автотриггер по статусу (`surveysTriggeredBy(stageId)` для задачи не сработает — нужен иной механизм по STATUS) + живой smoke на портале |
| NEW | `surveysTriggeredBy` мульти-сущность: составная фильтрация `(entityType, stageId)` + денормализация `entityType`/`spaEntityTypeId` из JSONB в колонки PgStore | store | предложен | сейчас GIN по `trigger_stages` работает для deal; namespace стадий spa другой |
| NEW | Админ-UI: список опросов с фильтром (по сущности/направлению) + редактор с привязкой к сущности — макеты на основе шаблонов печатных форм Bitrix24 | app | ✅ реализовано (#83 список+фильтр, #86+фаза5 конструктор) | референс выдержан; остаток — полировка (drag-and-drop, `/admin/*` в визуальный гейт) |
| NEW | `/admin/*` в визуальный гейт #13 (список + конструктор; light/dark × брейкпоинты) | UI | предложен | экраны сверены глазами, эталоны не сняты; добавить `*.visual.ts` + `DASHBOARD_DEV_OPEN=1`. См. `visual-gate.md` |
| NEW | Рефактор `CrmContext.dealStageId` → `entityStageId` (обобщённый триггер-ключ) | domain/store | предложен | сейчас поле перегружено семантикой (STATUS_ID лида/stageId СП); переименование тянет схему + миграцию + денормализацию PgStore — после стабилизации всех сущностей |
| NEW | Binding-слой мульти-сущности: `event.bind` на ONCRM<ENTITY>UPDATE + эндпоинт → `parseEntityUpdateEvent` → роутинг на `ENTITY_MAPPERS` (deal=null → `dealToCrmContext`) → приглашение | bitrix24 | предложен (ядро парс/мапперов готово, #82+) | требует живой портал; `verifyApplicationToken` ПЕРЕД `crm.*.get` (IDOR/cross-tenant по `spaEntityTypeId`) |

## Закрытые (контекст)

- **#3** — OAuth Bitrix24 + invitation-flow ядро (AES-256-GCM, refresh, startup-guard).
- **#5** — наблюдаемость ядро (логгер с редакцией, `/api/health`, process-хуки). Остаток — #15.
- **#6** — раннер миграций `node-pg-migrate` (`pnpm migrate up`).
- **#7** — read-API / PgStore (CRUD, tenant-изоляция, keyset-пагинация, SQL-агрегация).
- **#11** — HTTP-слой `/api/session`+`/api/submit` с анти-абьюзом (ядро #4).
- **#16** — invitation-flow ядро-рантайм (`Invitation` + проброс в submit).
- **#21** — `invitationPolicy` version-frozen (решение зафиксировано, см. `decisions.md`).
- **#22** — денормализация `triggerStages` + `IStore.surveysTriggeredBy` (GIN).
- **#24** — `SurveyFill` («мозг» прохождения опроса, контур A) — в `src/client`, под тестами.

> При расхождении источник истины — **живой GitHub**: правим этот файл под него,
> а не наоборот.

---
*Последнее ревью: 2026-06-21.*
