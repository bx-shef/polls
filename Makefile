# Деплой-команды (см. docs/admin-setup.md). Образ собирает CI в GHCR на мерже в main;
# на сервере watchtower подтягивает новый latest сам — ручной redeploy обычно не нужен.
# Переменные окружения берутся из .env.prod (конвенция сервера; docker compose по умолчанию
# читал бы .env, поэтому файл указан явно через --env-file).

COMPOSE_PROD = docker compose --env-file .env.prod -f docker-compose.prod.yml
COMPOSE_PROXY = docker compose --env-file .env.prod -f docker-compose.nginxproxy.yml

.PHONY: init-network init-nginxproxy prod-up prod-redeploy prod-down prod-logs

## Один раз: внешняя сеть для связи nginx-proxy ↔ приложение.
init-network:
	docker network inspect nginxproxy >/dev/null 2>&1 || docker network create nginxproxy

## Один раз: поднять reverse-proxy + TLS (Let's Encrypt).
init-nginxproxy:
	$(COMPOSE_PROXY) up -d

## Поднять приложение (образ из GHCR).
prod-up:
	$(COMPOSE_PROD) up -d

## Ручной redeploy: подтянуть свежий образ и пересоздать (обычно делает watchtower).
prod-redeploy:
	$(COMPOSE_PROD) pull
	$(COMPOSE_PROD) up -d

## Остановить приложение.
prod-down:
	$(COMPOSE_PROD) down

## Логи приложения.
prod-logs:
	$(COMPOSE_PROD) logs -f app
