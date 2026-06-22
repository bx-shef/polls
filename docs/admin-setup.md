# Инструкция для администратора — установка и запуск

Как собрать, развернуть и проверить сервис опросов. Два режима: **демо** (для показа
клиенту и ручного теста UI) и **прод** (постоянные данные, портал Bitrix24).

> ⚠️ **Важно про текущий статус.** Собранное приложение сейчас запускается на встроенном
> **демо-хранилище в памяти** (MemoryStore + сид): оба контура работают, данные
> **реалистичны, но эфемерны** (сбрасываются при рестарте). Привязка к PostgreSQL для
> постоянного хранения — отдельный шаг деплой-слоя (задача **#6**, см. ниже «Прод»).
> Поэтому сегодня готов к запуску **демо**; прод-хранение требует доделки #6.

## Требования

- Docker + Docker Compose (рекомендуется), **или** Node.js 22 + pnpm для запуска без Docker.
- Для прода: PostgreSQL 16, reverse-proxy с TLS (nginx/Caddy/Traefik), домен.

## Секреты (`.env`)

Скопируйте шаблон и заполните:

```bash
cp .env.example .env
openssl rand -hex 32   # для каждого секрета — своё значение
```

Ключевые переменные (полный список — в `.env.example`):

| Переменная | Зачем | Обязательна |
|---|---|---|
| `DASHBOARD_AUTH_SECRET` | HMAC-подпись сессии дашборда и handshake портала (≥ 32) | да в проде |
| `DASHBOARD_DEV_OPEN` | `=1` — открыть дашборд без сессии (ТОЛЬКО демо; в проде утечёт PII) | нет |
| `NUXT_BITRIX_TOKEN_KEY` | шифрование OAuth-токенов Bitrix24 в БД (AES-256-GCM, ≥ 64 hex) | да при связке |
| `DATABASE_URL` | строка подключения PostgreSQL (прод) | да в проде |
| `POSTGRES_PASSWORD` | пароль БД для docker-compose | да при `db` |
| `SURVEY_KEY_<ENTITY>` | какой опрос запускать по сущности из виджета (`SURVEY_KEY_DEAL`/`_LEAD`/`_SPA`/`_CONTACT`/`_COMPANY`/`_TASK`) | нет (дефолт `csat_postdeal`) |
| `SURVEY_KEY_DEFAULT` | опрос по умолчанию, если для сущности не задан свой | нет |

Правило безопасности: **слабый/пустой `DASHBOARD_AUTH_SECRET` в проде → дашборд отвечает
503** (fail-closed) — это защита, а не ошибка. Задайте сильный секрет.

## Демо-режим (показ клиенту / ручной тест)

Самый быстрый путь — Docker:

```bash
# из корня репозитория, с заполненным .env (можно без DATABASE_URL)
DASHBOARD_DEV_OPEN=1 docker compose up --build app
```

Откройте:
- Опрос (контур A): `http://localhost:3000/s/csat_postdeal`
- Дашборд (контур B): `http://localhost:3000/d/csat_postdeal`
- Health: `http://localhost:3000/api/health` → `200`

Без Docker:

```bash
pnpm install
pnpm build
DASHBOARD_DEV_OPEN=1 node .output/server/index.mjs   # PORT=3000 по умолчанию
```

> `DASHBOARD_DEV_OPEN=1` нужен, потому что собранный сервер бежит как production —
> иначе дашборд закрыт (fail-closed). В демо это безопасно (данные не настоящие).

Ручной тест-лист (галочки):
- [ ] Опрос проходится от интро до «Спасибо», ответы валидируются.
- [ ] Перезагрузка страницы опроса — прогресс сохраняется (resume).
- [ ] Дашборд показывает NPS/CSAT/распределения/тренд/срезы.
- [ ] Переключение светлая/тёмная тема (кнопка справа сверху).
- [ ] `/api/health` отвечает 200.

## Прод-режим (сервер + домен + TLS, авто-деплой)

Деплой устроен как непрерывная доставка: **мерж в `main` → GitHub Actions собирает образ в
GHCR (`ghcr.io/bx-shef/polls:latest`) → watchtower на сервере подтягивает его сам** (~5 мин).
TLS — Let's Encrypt через ОБЩИЙ nginx-proxy сервера (внешняя сеть `proxy-net` уже поднята
другими проектами). Постоянное хранение в PostgreSQL включается в #6 (до него — демо-стор,
данные эфемерны).

**Подготовка образа:** пакет `ghcr.io/bx-shef/polls` сделать **public** (чтобы watchtower тянул
обновления без креденшелов, как остальные `bx-shef/*`). Иначе первый `make prod-up` потребует
`docker login ghcr.io` (PAT с `read:packages`), а авто-обновления watchtower работать не будут.

**Деплой-файлы проекта** (`/home/bitrix/polls/`, репозиторий публичный — raw без авторизации):

```bash
BASE=https://raw.githubusercontent.com/bx-shef/polls/main
curl -fsSL $BASE/docker-compose.prod.yml       -o docker-compose.prod.yml
curl -fsSL $BASE/docker-compose.nginxproxy.yml -o docker-compose.nginxproxy.yml
curl -fsSL $BASE/Makefile                       -o Makefile
curl -fsSL $BASE/.env.prod.example              -o .env.prod   # заполнить DOMAIN + секреты
```

**Запуск — два случая:**

```bash
# A) ЧИСТЫЙ сервер (тиражирование): поднять общий прокси/сеть с нуля, затем приложение.
make init-network init-nginxproxy   # требует LETSENCRYPT_EMAIL в .env.prod
make prod-up

# B) Сервер с УЖЕ поднятым nginx-proxy на proxy-net (как bx-shef): только приложение.
make prod-up
```

После этого:
- **A-запись** домена `DOMAIN` → сервер; nginx-proxy выпустит TLS сам (email из глобального acme).
- **Авто-деплой**: каждый зелёный мерж в `main` → новый образ → watchtower обновит контейнер.
  Ручной апдейт при необходимости: `make prod-redeploy`. Логи: `make prod-logs`.

**Проверка:** `https://DOMAIN/api/health` → `200`; опрос `https://DOMAIN/s/csat_postdeal`.
Дашборд `/d/:key` в проде закрыт авторизацией портала (см. ниже) — это by design.

**Bitrix24-приложение:** зарегистрировать локальное приложение портала, прописать
`NUXT_B24_CLIENT_ID/SECRET`, указать путь дашборда как placement (HTTPS обязателен — cookie
`Secure; SameSite=None; Partitioned`). Обмен токенов и handshake фрейма (`POST /api/b24/session`)
уже реализованы в ядре; резолвер портала подключается с PgStore (#6).

### Что остаётся доделать для полноценного прода

Эти пункты — деплой-слой, требуют живого сервера/портала (отслеживаются в [issues.md](./issues.md)):

- **#6/#49** — привязка Nitro к **PgStore по `DATABASE_URL`** (сейчас стор — в памяти):
  пул соединений, выбор PgStore вместо MemoryStore, подстановка резолвера портала
  (`setPortalResolver(domain → member_id)` — ядро готово), tenant-фильтрация по `portalId`.
  **Без этого данные не сохраняются между рестартами.**
- **#4** — общий стор анти-абьюза (nonce/лимиты/приглашения) для мульти-инстанса,
  `X-Forwarded-For` за доверенным прокси.
- **#5/#15** — наблюдаемость на проде: логи в Pino, Sentry, метрики, живой `/health`.
- **#17** — триггер `ONCRMDEALUPDATE` (запуск опроса по стадии сделки).

> Rate-limit на `/api/b24/session` (release-gate) — уже сделан (10/60с на IP); за доверенным
> reverse-proxy включите `X-Forwarded-For` (общий стор лимитов для мульти-инстанса — #4).

## Здоровье и эксплуатация

- **Health-check**: `GET /api/health` → `200` (стор жив) или `503`. Используйте в
  Docker healthcheck / балансировщике.
- **Логи**: структурный JSON в stdout (секреты редактируются). Уровень — `NUXT_LOG_LEVEL`.
- **Обновление**: пересобрать образ (`docker compose build app`) и перезапустить; для прод-БД
  — сначала `pnpm migrate up` (миграции идемпотентны).

## Частые проблемы

| Симптом | Причина | Решение |
|---|---|---|
| Дашборд отдаёт `503` | нет/слабый `DASHBOARD_AUTH_SECRET` в проде | задать секрет ≥ 32, либо демо `DASHBOARD_DEV_OPEN=1` |
| Дашборд отдаёт `401` | нет валидной сессии портала | пройти handshake из фрейма Bitrix24 (`/api/b24/session`) |
| Данные пропали после рестарта | работает MemoryStore (демо) | привязать PgStore (#6) — см. выше |
| Cookie не ставится во фрейме | нет HTTPS | включить TLS (нужно для `Secure; SameSite=None; Partitioned`) |
| `/api/b24/session` → `401` всегда | резолвер портала ещё no-op (#6/#49) | завершить привязку PgStore + `setPortalResolver` |
