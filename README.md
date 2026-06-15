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
src/server/    адаптер node:http (pnpm serve); Nitro-обёртка — фаза связки
src/demo/      детерминированный сид (общий для verify и тестов)
scripts/       verify.ts, serve.ts, check.sh / check.ps1 (кросс-платформенная проверка)
test/          vitest; покрытие ядра 100% (строки/ветви/функции), CI гейтит на 85% (vitest.config.ts)
migrations/    PostgreSQL-схема (0001_init.sql)
docker-compose.yml   локальная БД (миграции применяются автоматически)
```

Ядро framework-agnostic — в фазе связки с Bitrix24 оно ляжет в Nuxt `server/`
без переписывания (см. [бриф §9](./docs/brief.md), [модель данных](./docs/data-model.md)).

## Документация

- [**Бриф**](./docs/brief.md) — спецификация сервиса опросов: пользовательский
  поток, структура 25 вопросов в 8 блоках, механика «Другое — свой вариант»,
  бэкенд-контракт, принятые решения (PostgreSQL, дашборд, домен
  `polls.bx-shef.by`), сценарии применения (опрос по сделке → KPI, опросы
  сотрудников → Живая лента), реализация на
  [templates-dashboard](https://github.com/bitrix24/templates-dashboard) и
  деплой по образцу [templates-mcp](https://github.com/bitrix24/templates-mcp).
- [**Дизайн на b24ui**](./docs/design.md) — раскладки и блоки прототипа на
  компонентах [Bitrix24 UI](https://bitrix24.github.io/b24ui/llms.txt) с примерами
  кода (десктоп + мобильный, дашборд результатов).
- [**Модель данных**](./docs/data-model.md) — внесение вопросов, иерархия
  пользователь→группа→опрос→версия, версионирование, схема PostgreSQL, связь с CRM
  и итог на 4 уровнях (опрос / услуга / клиент / направление).
- [Обезличенный шаблон схемы](./docs/reference/survey-schema.template.json) —
  структурный скелет опроса (типы, флаги, блоки) без оригинальных формулировок.

---
*Последнее ревью: 2026-06-15.*
