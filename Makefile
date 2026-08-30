.DEFAULT_GOAL := help
.PHONY: help up down dev check image prod-pull prod-up prod-down prod-logs prod-migrate prod-ps

IMAGE ?= ghcr.io/bx-shef/polls
TAG   ?= latest
PROD  := docker compose -f deploy/compose.yaml

help: ## Показать список команд
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- Разработка --------------------------------------------------------------

up: ## Поднять Postgres и Redis для разработки
	docker compose up -d

down: ## Погасить Postgres и Redis
	docker compose down

dev: ## Запустить приложение в режиме разработки
	pnpm dev

check: ## Единый гейт перед пушем: слои, линт, типы, тесты
	pnpm check

# --- Образ -------------------------------------------------------------------

image: ## Собрать образ приложения локально
	docker build -f deploy/Dockerfile -t $(IMAGE):$(TAG) \
		--build-arg APP_VERSION=$(shell git rev-parse --short HEAD) .

# --- Прод --------------------------------------------------------------------
#
# TLS, сертификаты и обновление образов — забота общей инфраструктуры хоста
# (nginx-proxy, acme-companion и один Watchtower на все проекты), поэтому целей
# вроде `cert` здесь нет: сертификат выпускается сам по LETSENCRYPT_HOST.

prod-pull: ## Забрать свежий образ
	$(PROD) pull

prod-up: ## Поднять прод-стек
	$(PROD) up -d

prod-down: ## Погасить прод-стек
	$(PROD) down

prod-ps: ## Состояние контейнеров стека
	$(PROD) ps

prod-logs: ## Смотреть логи приложения
	$(PROD) logs -f app

prod-migrate: ## Накатить миграции одноразовым запуском образа
	$(PROD) run --rm migrate
