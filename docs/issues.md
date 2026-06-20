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
| #17 | Invitation binding `ONCRMDEALUPDATE` + вшивание `invitationPolicy` в схему/PgStore | bitrix24 | открыт (ядро парс/верификации/маппинга сделано) | `invitationPolicy` version-frozen (#21), `triggerStages`+`surveysTriggeredBy` (#22), invitation-flow (#16). Ядро триггера: `src/bitrix24/deal-event.ts` (`parseDealUpdateEvent` + `verifyApplicationToken` анти-форджери + `dealToCrmContext` из `crm.deal.get`) под тестами. Осталось (живой портал): эндпоинт `POST /api/b24/deal-update` → верификация → `crm.deal.get` токеном портала → `surveysTriggeredBy` → создание приглашений (идемпотентно по deal+survey); регистрация `event.bind` + хранение `application_token` при OAuth-установке; обогащение имён (company/category/user.get); живой smoke. Связан с #4 (общий стор приглашений) |
| #15 | Наблюдаемость на деплое: `Logger`→Pino / `onFatal`→Sentry, метрики/OTel, ip-политика | деплой | открыт | ядро #5 ✅; чистый деплой-слой |
| #13 | Визуальная верификация UI: Playwright + `Stop`-хук + регресс-тесты | UI | инфра ✅ (фикстура-заглушка) | машинерия доказана end-to-end; фикстуры → маршруты с приходом экранов; CI-интеграция позже (`docs/visual-gate.md`) |
| #31 | PII-редакция на HTTP-границе (ляжет с read-эндпоинтом ответов контура B) | store/api | открыт | нет публичного read-ответов → нет калл-сайта; не плодим dead code |
| #10 | Read-API хвост: `GET /api/survey/:key/current` ✅ (#29), SQL-`npsTrend` ✅, PII-редакция → #31 | store/api | открыт (хвост → #31) | основное сделано; остался только PII-хвост (#31) |
| #4 | Серверный анти-абьюз: общий стор nonce/лимитов/приглашений (мульти-инстанс), `X-Forwarded-For` | деплой | ядро для 1 инстанса ✅ (#11); durable-идемпотентность ответа ✅ (0003) | общий стор → мульти-инстанс; связь `invitation_id` с #17 |
| #47 | Дашборд контура B: auth-гейтинг + tenant-изоляция (`portalId`) под OAuth Bitrix24 | bitrix24/деплой | открыт (гейт + ядро handshake сделаны) | `requirePortalSession` + подписанная сессия (`src/api/session.ts`) — fail-closed в проде. Ядро handshake фрейма (`src/bitrix24/frame.ts`: SSRF-allowlist + анти-cross-tenant + минт сессии) + боевой `authenticate` (`src/bitrix24/authenticate.ts`: `app.info` + резолв `member_id` из install-маппинга, под тестами) + эндпоинт `POST /api/b24/session` (cookie `polls_portal` `SameSite=None; Secure; Partitioned`, fail-closed; smoke `pnpm build`+curl). Резолвер `domain → member_id` сделан ядром (`resolveMemberIdByDomain`, pglite-тесты) — осталось подставить его в `setPortalResolver` через pg-Pool + tenant-фильтр стора (нужен Nitro-pg-Pool по `DATABASE_URL`) — слой #49/#6 |
| #49 | Дашборд контура B: SQL-агрегация (PgStore) + rate-limit + per-bin k-анонимность | store/api | открыт (заведён в сессии) | rate-limit `/api/b24/session` сделан (`allowB24Session`, 10/60с/IP); сейчас агрегат in-memory над сидом — для реальных данных нужен Nitro-pg-Pool (#6) + SQL-агрегат + ужесточение подавления |

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
*Последнее ревью: 2026-06-19.*
