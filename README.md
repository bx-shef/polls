# polls

Сервис опросов.

## Быстрый старт (локальная проверка итога)

```bash
pnpm install
pnpm check       # типы + тесты + расчёт итога одной командой
pnpm verify      # только печать итога на 4 уровнях
pnpm test        # юнит-тесты (vitest)
pnpm typecheck   # проверка типов
pnpm test:cov    # покрытие
```

Кросс-платформенно одной командой (без набора команд): `bash scripts/check.sh`
(Linux/macOS) или `powershell -ExecutionPolicy Bypass -File scripts\check.ps1`
(Windows) — установит зависимости, проверит типы, прогонит тесты и покажет итог.

`pnpm verify` строит детерминированный набор (1 опрос, 2 версии, 12 ответов с
CRM-контекстом) и показывает итог: NPS/CSAT/распределения по опросу, услуге,
клиенту и направлению + KPI ответственных и тренд через границу версий.

### Структура ядра

```
src/domain/    schema, metrics, answers, compile (версии), aggregate (4 уровня)
src/store/     memory (тесты/локально) + PgStore (PostgreSQL: транзакции, SQL-агрегация с подавлением малых N; тесты на pglite)
src/api/       HTTP-хендлеры /api/session + /api/submit (framework-agnostic) + анти-абьюз (nonce TTL, honeypot, rate-limit)
src/server/    адаптер node:http (pnpm serve); Nitro-привязка построена в server/
src/demo/      детерминированный сид (общий для verify и тестов)
scripts/       verify.ts, serve.ts, check.sh / check.ps1 (кросс-платформенная проверка)
test/          vitest; покрытие ядра ~100% (99.83%; строки/ветви/функции), CI гейтит на 85% (vitest.config.ts)
migrations/    PostgreSQL-схема (0001_init.sql)
docker-compose.yml   локальная БД (миграции применяются автоматически)
```

Ядро framework-agnostic — легло в Nuxt `server/` без переписывания
(архитектура и модель данных — [карта проекта](./docs/project-map.md)).

## Запуск приложения (демо / деплой)

Развернуть собранное приложение (опрос + дашборд) — Docker или Node. Демо бежит на
встроенных данных (БД не нужна); прод-хранение в PostgreSQL включается заданием
`DATABASE_URL` (прод-`docker-compose.prod.yml` разводит Postgres + volume).
Полная инструкция, секреты и тест-лист — [карта проекта](./docs/project-map.md) §Деплой и эксплуатация.

```bash
cp .env.example .env                                   # заполнить секреты
DASHBOARD_DEV_OPEN=1 docker compose up --build app     # демо на http://localhost:3000
# опрос: /s/csat_postdeal · дашборд: /d/csat_postdeal · health: /api/health
```

## Документация

- [**Карта проекта**](./docs/project-map.md) — единый источник правды: что это и зачем,
  архитектура, модель данных (PostgreSQL), интеграция Bitrix24, деплой/эксплуатация/секреты,
  безопасность, дизайн (b24ui), ключевые решения, статус «что сделано / что проверить»,
  дальнейшая работа, глоссарий.
- [**Процесс**](./docs/process.md) — как работает сервис «от и до» простыми словами
  (датчик CRM → опрос → аналитика) и как управлять опросами.
- [**Открытые задачи**](./docs/issues.md) — карта issue: статус и зависимости.
- [Обезличенный шаблон схемы](./docs/reference/survey-schema.template.json) —
  структурный скелет опроса (типы, флаги, блоки) без оригинальных формулировок.

---
*Последнее ревью: 2026-07-24.*
