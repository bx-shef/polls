# Деплой-команды для /home/bitrix/polls/ (см. docs/project-map.md).
# Образ собирает CI в GHCR на мерже в main; watchtower подтягивает новый latest сам.
# Переменные берутся из .env.prod (конвенция сервера; иначе docker compose читал бы .env).
#
# Чистый сервер (тиражирование):  make init-network init-nginxproxy prod-up
# Сервер с уже поднятым прокси:    make prod-up   (init-* пропустить)

COMPOSE = docker compose --env-file .env.prod -f docker-compose.prod.yml
COMPOSE_PROXY = docker compose --env-file .env.prod -f docker-compose.nginxproxy.yml

.PHONY: init-network init-nginxproxy prod-up prod-redeploy prod-down prod-logs

## Один раз на сервере: общая внешняя сеть прокси (идемпотентно).
init-network:
	docker network inspect proxy-net >/dev/null 2>&1 || docker network create proxy-net

## Один раз на сервере: общий reverse-proxy + TLS. ПРОПУСТИТЬ, если прокси уже запущен.
init-nginxproxy:
	$(COMPOSE_PROXY) up -d

## Поднять приложение (образ из GHCR, подключение к существующему proxy-net).
prod-up:
	$(COMPOSE) up -d

## Ручной redeploy: подтянуть свежий образ и пересоздать (обычно делает watchtower).
prod-redeploy:
	$(COMPOSE) pull
	$(COMPOSE) up -d

## Остановить приложение.
prod-down:
	$(COMPOSE) down

## Логи приложения.
prod-logs:
	$(COMPOSE) logs -f app
