# CLAUDE.md

Ядро сервиса опросов (движок + версионирование + аналитика) под будущую
интеграцию с Bitrix24. Сейчас в репозитории — **только ядро** (TypeScript,
framework-agnostic), без сетевого слоя. Комментарии и документация — на русском.

## Команды

```bash
pnpm check        # всё разом: typecheck + test (с покрытием) + verify
bash scripts/check.sh                                   # то же, Linux/macOS, с pnpm install
powershell -ExecutionPolicy Bypass -File scripts\check.ps1   # то же, Windows
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm test:cov     # vitest + покрытие (пороги 85% в vitest.config.ts; CI гейтит этим)
pnpm verify       # печатает И сверяет assert'ами итог на 4 уровнях (src/demo/seed.ts)
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
  (`Queryable` ≈ `pg.Pool`/pglite), tenant-scoped по `portalId`; тесты на pglite (in-process).
  `store/cursor.ts` — helpers keyset-курсора (encode/decode/compare). Read-API расширения — #7.
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

## Скоуп и роадмап

Сетевой/деплой-слой вынесен в ISSUE (не дефекты ядра):
- **#3** — OAuth Bitrix24 (в т.ч. шифрование токенов в БД).
- **#4** — анти-абьюз: серверный nonce (TTL), rate-limit, honeypot, идемпотентность.
- **#5** — наблюдаемость: структурные логи/метрики/трейсы + `/health`.
- **#6** — раннер миграций (`0002+`).
- **read-API / PgStore** — `PgStore` (CRUD + tenant-изоляция) и keyset-пагинация
  (`listResponsesPage`) сделаны; осталось: SQL-агрегация, принудительное подавление
  малых N на срезах, денормализация контекста, транзакции (ISSUE [#7](https://github.com/bx-shef/polls/issues/7)).

## Документация (`docs/`)

`brief.md` (спецификация), `design.md` (b24ui), `data-model.md` (PostgreSQL + аналитика),
`reference/survey-schema.template.json` (обезличенный шаблон — валидный `SurveyDraft`).

## Среда (web-сессии)

SessionStart-хук настроен: `.claude/hooks/session-start.sh` (зарегистрирован в
`.claude/settings.json`) ставит зависимости (`pnpm install --frozen-lockfile`) при
старте веб-сессии Claude Code, чтобы typecheck/test/verify работали сразу.
Запускается синхронно и только в удалённой среде (гард по `CLAUDE_CODE_REMOTE`);
локально — мгновенный выход. Вступает в силу для всех сессий после мержа в
дефолтную ветку.

---
*Последнее ревью: 2026-06-11.*
