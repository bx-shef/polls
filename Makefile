# Деплой-команды для /home/bitrix/polls/ (см. docs/admin-setup.md).
# Образ собирает CI в GHCR на мерже в main; watchtower подтягивает новый latest сам.
# Общий reverse-proxy (nginx-proxy + acme-companion) на сервере уже запущен и обслуживает
# все проекты через внешнюю сеть proxy-net — отдельный прокси поднимать не нужно.
# Переменные берутся из .env.prod (конвенция сервера; иначе docker compose читал бы .env).

COMPOSE = docker compose --env-file .env.prod -f docker-compose.prod.yml

.PHONY: prod-up prod-redeploy prod-down prod-logs

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
