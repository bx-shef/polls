.DEFAULT_GOAL := help
.PHONY: help up down dev check image prod-pull prod-up prod-down prod-logs prod-migrate cert cert-renew

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

image: ## Собрать образ приложения
	docker build -f deploy/Dockerfile -t $(IMAGE):$(TAG) \
		--build-arg APP_VERSION=$(shell git rev-parse --short HEAD) .

# --- Прод --------------------------------------------------------------------

prod-pull: ## Забрать свежий образ
	$(PROD) pull

prod-up: ## Поднять прод-стек
	$(PROD) up -d

prod-down: ## Погасить прод-стек
	$(PROD) down

prod-logs: ## Смотреть логи приложения
	$(PROD) logs -f app

prod-migrate: ## Накатить миграции одноразовым запуском образа
	$(PROD) run --rm migrate

# --- Сертификат --------------------------------------------------------------

ACME := $(abspath deploy/acme)

# Первый выпуск. Боевой nginx.conf без файлов сертификата не стартует, поэтому
# на время проверки поднимается временный nginx с nginx-bootstrap.conf — только
# 80 порт и каталог проверки. Дальше `make prod-up` поднимает настоящий стек.
cert: ## Выпустить первый сертификат (DOMAIN=..., EMAIL=...)
	@test -n "$(DOMAIN)" || (echo "Укажите DOMAIN=polls.bx-shef.by" && exit 1)
	@test -n "$(EMAIL)" || (echo "Укажите EMAIL=admin@bx-shef.by" && exit 1)
	mkdir -p $(ACME)
	-docker rm -f survey-acme
	docker run -d --name survey-acme -p 80:80 \
		-v $(abspath deploy/nginx-bootstrap.conf):/etc/nginx/nginx.conf:ro \
		-v $(ACME):/var/www/certbot \
		nginx:1.29-alpine
	docker run --rm \
		-v /etc/letsencrypt:/etc/letsencrypt \
		-v $(ACME):/var/www/certbot \
		certbot/certbot certonly --webroot -w /var/www/certbot \
		-d $(DOMAIN) --email $(EMAIL) --agree-tos --no-eff-email; \
		status=$$?; docker rm -f survey-acme > /dev/null; exit $$status

cert-renew: ## Продлить сертификат на работающем стеке (в cron раз в сутки)
	docker run --rm \
		-v /etc/letsencrypt:/etc/letsencrypt \
		-v $(ACME):/var/www/certbot \
		certbot/certbot renew --webroot -w /var/www/certbot
	$(PROD) exec nginx nginx -s reload
