# Один Makefile на два места — репозиторий и сервер.
#
# ⚠ НА СЕРВЕРЕ РЕПОЗИТОРИЯ НЕТ. Там лежат ровно три файла: `compose.yaml`, этот `Makefile`
# и `.env` (`deploy/README.md`). Поэтому цели разработки там нечем выполнить, а прод-стек
# лежит по другому пути. Отсюда две развилки ниже — в них весь смысл этого файла.
#
# Прошлая версия жёстко искала `deploy/compose.yaml`, и на сервере любая цель падала с
# «No rule to make target» — сообщение, которое GNU make выдаёт, когда makefile не найден
# вовсе, то есть уводит от настоящей причины.

.DEFAULT_GOAL := help
.PHONY: help up down dev check image \
        prod-pull prod-up prod-down prod-logs prod-migrate prod-ps \
        doctor host-update compose-found prod-tail prod-portals prod-inbox \
        prod-stuck prod-retry

IMAGE ?= ghcr.io/bx-shef/polls
TAG   ?= latest

# --- Развилка 1: где прод-стек ----------------------------------------------
#
# Порядок важен. В репозитории есть ОБА файла, и корневой `compose.yaml` — это стек
# разработки (только база и Redis): прод-цель, взявшая его, подняла бы не то.
COMPOSE_FILE := $(firstword $(wildcard deploy/compose.yaml compose.yaml))
PROD := docker compose -f $(COMPOSE_FILE)

# Compose читает `.env` из каталога compose-файла, а не из текущего — проверено
# запросом `docker compose config` с двумя разными `.env`.
ENV_FILE := $(dir $(COMPOSE_FILE)).env

# --- Развилка 2: цели разработки ---------------------------------------------
#
# Им нужны исходники, которых на сервере нет. И это не просто «не сработает»:
# `make down` на сервере погасил бы боевое приложение вместо локальной базы, потому
# что `compose.yaml` там — прод-стек. Поэтому они сначала проверяют `package.json`.
DEV_ONLY = test -f package.json || { echo 'Цель «$@» работает только в репозитории: на сервере нет исходников, а compose.yaml там — прод-стек.' >&2; exit 1; }

# Прочитать одно значение из `.env`, ничего не исполняя.
#
# `set -a; . ./.env` — это ЗАПУСК файла как скрипта: пароль с пробелом превращается в
# команду, а `$$(…)` внутри значения выполняется. Здесь берётся ровно одна строка
# `КЛЮЧ=значение`, снимаются обрамляющие кавычки и комментарий в конце строки — то,
# что для compose норма и иначе доехало бы сюда мусором.
env-value = $$(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$(1)[[:space:]]*=//p' $(ENV_FILE) 2>/dev/null \
	| head -1 \
	| sed -e 's/^[[:space:]]*//' -e 's/[[:space:]][[:space:]]*\#.*$$//' -e 's/[[:space:]]*$$//' \
	      -e 's/^"\(.*\)"$$/\1/' -e "s/^'\(.*\)'\$$/\1/")

help: ## Показать список команд
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  прод-стек: $(if $(COMPOSE_FILE),$(COMPOSE_FILE),НЕ НАЙДЕН — нужен ./compose.yaml)"

compose-found:
	@test -n '$(COMPOSE_FILE)' || { \
		echo 'Рядом нет ни ./compose.yaml, ни deploy/compose.yaml — прод-целям не с чем работать.' >&2; \
		echo 'На сервере файл берётся так: make host-update (или curl, см. deploy/README.md).' >&2; \
		exit 1; }

# --- Разработка --------------------------------------------------------------

up: ## Поднять Postgres и Redis для разработки
	@$(DEV_ONLY)
	docker compose -f compose.yaml up -d

down: ## Погасить Postgres и Redis
	@$(DEV_ONLY)
	docker compose -f compose.yaml down

dev: ## Запустить приложение в режиме разработки
	@$(DEV_ONLY)
	pnpm dev

check: ## Единый гейт перед пушем: слои, линт, типы, тесты
	@$(DEV_ONLY)
	pnpm check

image: ## Собрать образ приложения локально
	@$(DEV_ONLY)
	docker build -f deploy/Dockerfile -t $(IMAGE):$(TAG) \
		--build-arg APP_VERSION=$$(git rev-parse --short HEAD) .

# --- Прод --------------------------------------------------------------------
#
# TLS, сертификаты и обновление образов — забота общей инфраструктуры хоста
# (nginx-proxy, acme-companion и один Watchtower на все проекты), поэтому целей
# вроде `cert` здесь нет: сертификат выпускается сам по LETSENCRYPT_HOST.

prod-pull: compose-found ## Забрать свежий образ
	$(PROD) pull

prod-up: compose-found ## Поднять прод-стек
	$(PROD) up -d

prod-down: compose-found ## Погасить прод-стек
	$(PROD) down

prod-ps: compose-found ## Состояние контейнеров стека
	$(PROD) ps

prod-logs: compose-found ## Смотреть логи приложения вживую (не завершается, Ctrl+C)
	$(PROD) logs -f app

# ⚠ Отдельная цель, а не флаг к `prod-logs`. Та следует за журналом и НЕ ЗАВЕРШАЕТСЯ —
# значит `make prod-logs | grep …` не отдаёт ничего и выглядит как зависший терминал.
# Ровно на это наступили, разбирая первую живую установку: журнал есть, посмотреть нечем.
# Для разбора нужен конечный вывод, для наблюдения — бесконечный; это две разные команды.
LINES ?= 2000
prod-tail: compose-found ## Последние LINES строк журнала и выйти — для grep (LINES=2000)
	$(PROD) logs --no-color --tail=$(LINES) app

# ⚠ Колонки перечислены поимённо, и `SELECT *` здесь запрещён намеренно: в таблице лежат
# шифротексты токенов портала, а вывод команды человек копирует в переписку не задумываясь.
# Про `application_token` спрашиваем ФАКТ, а не значение: он отвечает на вопрос, приходило ли
# событие установки, — у мастера его неоткуда взять, и колонка остаётся пустой.
#
# ⚠ `grant_revoked_at` и расчётный срок стирания добавлены после того, как цель показала
# живой портал БЕЗ них: она написана раньше, чем появилась колонка, и не показывала ровно
# то состояние, ради которого механизм отмирания портала и заводился. Инструмент, который
# не показывает главного, хуже отсутствующего — на него полагаются.
# Срок считается запросом, а не держится в голове: тридцать суток — `PURGE_GRACE_DAYS`.
prod-portals: compose-found ## Состояние установленных порталов (без токенов)
	@$(PROD) exec -T db psql -U survey -d survey -xc "select domain, status, scopes, license, application_token is not null as event_token_present, grant_revoked_at, case when grant_revoked_at is null then null else (grant_revoked_at + interval '30 days')::date end as purge_due, installed_at, updated_at from portals order by installed_at"

# ⚠ `payload` не показывается и показан не будет: в нём лежит ответ живого человека,
# а вывод команды копируют в переписку не задумываясь. Это тот же инвариант, по которому
# ответ не попадает в журнал, — команда оператора ничем не лучше журнала. `token_hash`
# опущен по другой причине: он ключ к ссылке, и делу не помогает.
#
# ⚠ Цель заведена после первого сквозного прогона на живом портале. Ответ ушёл, комментарий
# в сделке не появился, и посмотреть, лежит ли ответ ещё в буфере или давно доставлен,
# было НЕЧЕМ: единственный признак — строка в журнале, которую легко пролистать.
# Пустая выдача — здоровое состояние: доставленный ответ у нас не хранится.
prod-inbox: compose-found ## Что лежит в буфере ответов (без текста ответов)
	@$(PROD) exec -T db psql -U survey -d survey -c "select status, count(*) as n, min(received_at) as oldest from inbox group by status order by status"
	@$(PROD) exec -T db psql -U survey -d survey -c "select status, attempts, left(coalesce(last_error, '—'), 120) as last_error, received_at, next_attempt_at from inbox order by received_at limit 20"

# ⚠ ОТДЕЛЬНАЯ ЦЕЛЬ, А НЕ РАСШИРЕНИЕ `prod-inbox`, и причина в том, что `prod-inbox`
# показывает ПЕРВЫЕ ДВАДЦАТЬ строк по времени получения. Застрявшие — самые старые лишь
# до первого всплеска: двадцать свежих `pending` прячут `failed` за край выдачи ровно тогда,
# когда буфер и так не в порядке. Инструмент, теряющий главное под нагрузкой, хуже
# отсутствующего — на него полагаются (issue #24).
#
# ⚠ Домен портала джойнится сюда намеренно: без него строка отвечает «что-то не доставилось»
# и не отвечает «кому». Почти все причины отказа чинятся на стороне КОНКРЕТНОГО портала —
# права, переустановка, тариф, — и без домена оператору некуда идти.
#
# ⚠ `payload` не показывается и показан не будет: в нём ответ живого человека. `token_hash`
# — префиксом: сопоставить строку с приглашением он позволяет, ключом к ссылке не служит.
prod-stuck: compose-found ## Ответы, застрявшие в failed: чей портал, сколько попыток, код отказа
	@$(PROD) exec -T db psql -U survey -d survey -c "select i.id, p.domain, i.attempts, coalesce(i.last_error, '—') as last_error, left(i.token_hash, 8) as token, i.received_at from inbox i join portals p on p.id = i.portal_id where i.status = 'failed' order by i.received_at"

# ⚠ ПО УМОЛЧАНИЮ — СУХОЙ ПРОГОН, запись только по `APPLY=1`. Тот же порядок, что
# у операторских команд переноса, и по той же причине: «посмотреть» и «сделать» обязаны
# быть разными нажатиями, когда действие трогает чужие данные.
#
# ⚠ `attempts` СБРАСЫВАЕТСЯ В НОЛЬ, и без этого цель была бы пустышкой: строка попала
# в `failed`, исчерпав предел попыток, и вернувшись в `pending` с прежним счётчиком
# упёрлась бы в тот же предел на первой же попытке. Внешне — «повторил, не помогло».
#
# ⚠ `next_attempt_at` ставится в `now()`: без него строка ждала бы прежней отложенной
# даты, то есть до часа тишины после команды, которую оператор выполнил только что.
#
# Отбор: `DOMAIN=портал.bitrix24.ru` — все застрявшие одного портала (основной случай,
# причина обычно общая), `ID=<uuid>` — ровно одна строка. Без обоих — все сразу.
prod-retry: compose-found ## Вернуть failed в pending (сухой прогон; APPLY=1 — записать)
	@dom='$(DOMAIN)'; row='$(ID)'; 	where="i.status = 'failed'"; 	if [ -n "$$dom" ]; then where="$$where and p.domain = '$$dom'"; fi; 	if [ -n "$$row" ]; then where="$$where and i.id = '$$row'"; fi; 	if [ -z "$(APPLY)" ]; then 		echo 'СУХОЙ ПРОГОН — ничего не изменено. Записать: та же команда с APPLY=1'; 		$(PROD) exec -T db psql -U survey -d survey -c "select i.id, p.domain, i.attempts, coalesce(i.last_error, '—') as last_error from inbox i join portals p on p.id = i.portal_id where $$where order by i.received_at"; 	else 		$(PROD) exec -T db psql -U survey -d survey -c "update inbox set status = 'pending', attempts = 0, next_attempt_at = now() where id in (select i.id from inbox i join portals p on p.id = i.portal_id where $$where)"; 	fi

prod-migrate: compose-found ## Накатить миграции одноразовым запуском образа
	$(PROD) run --rm migrate

# --- Диагностика -------------------------------------------------------------
#
# Тело проверки живёт прямо здесь, а не скачивается скриптом: этот файл на сервере
# уже лежит, а диагностику зовут ровно тогда, когда что-то не работает — в том числе
# сеть. Проверка, которой нужен интернет, чтобы начаться, бесполезна в аварию.
#
# Проверяется не «всё подряд», а те развилки, на которых мы уже спотыкались:
# нет compose-файла · нет DOMAIN · контейнер не поднят · контейнер не в proxy-net ·
# прокси не создал vhost · нет сертификата (снаружи это выглядит как
# ERR_SSL_UNRECOGNIZED_NAME_ALERT, и на приложение не указывает ничем).
#
# Отдельно — миграции. `/api/health` их не видит: он делает `select 1`, а тот проходит и
# на пустой базе, поэтому «status: ok» при отсутствующей схеме выглядит как исправность.
# Сверяем учёт drizzle (схема `drizzle`, таблица `__drizzle_migrations` — имена взяты из
# исходника `drizzle-orm`, не по памяти) с числом файлов миграций в самом образе: так
# видно и «не накатывали вовсе», и «накатили не всё», и «образ старее базы».
#
# Имя роли и базы (`survey`) продублировано из `compose.yaml`. Дублирование осознанное:
# альтернатива — вытаскивать его из DATABASE_URL контейнера, то есть разбирать строку
# с паролем в шелле ради значения, которое меняется раз в жизни проекта.

doctor: compose-found ## Диагностика на сервере: почему домен не отвечает
	@set -u; \
	g() { printf '  \033[32mОК\033[0m    %s\n' "$$1"; }; \
	b() { printf '  \033[31mПЛОХО\033[0m %s\n' "$$1"; }; \
	i() { printf '  \033[33m?\033[0m     %s\n' "$$1"; }; \
	probe() { o=$$(curl -sS -m 10 -o /dev/null -w '%{http_code}' $$2 2>&1) \
		&& { [ "$$o" = 200 ] && g "$$1 -> 200" || $$3 "$$1 -> $$o"; } \
		|| b "$$1 -> $$(printf '%s' "$$o" | tr '\n' ' ' | sed 's/ *000 *$$//')"; }; \
	echo 'Файлы'; \
	g 'compose-файл: $(COMPOSE_FILE)'; \
	if [ -f '$(ENV_FILE)' ]; then g '$(ENV_FILE) на месте'; else b '$(ENV_FILE) нет — compose не увидит ни DOMAIN, ни пароля'; fi; \
	dom="$(call env-value,DOMAIN)"; \
	if [ -n "$$dom" ]; then g "DOMAIN=$$dom"; else b 'DOMAIN не задан — без него compose не стартует вовсе'; fi; \
	echo 'Наш стек'; \
	app=$$($(PROD) ps -q app 2>/dev/null | head -1); \
	if [ -n "$$app" ]; then \
		g "приложение: $$(docker inspect -f '{{.Name}} — {{.State.Status}}' $$app | sed 's|^/||')"; \
		nets=$$(docker inspect -f '{{range $$n,$$_ := .NetworkSettings.Networks}}{{$$n}} {{end}}' $$app); \
		case " $$nets " in \
			*' proxy-net '*) g "сети: $$nets";; \
			*) b "не подключён к proxy-net (сети: $$nets) — прокси его не видит";; \
		esac; \
		docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $$app \
			| grep -E '^(VIRTUAL_HOST|VIRTUAL_PORT|LETSENCRYPT_HOST)=' \
			| while read -r v; do g "$$v"; done; \
		out=$$(docker exec "$$app" node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>r.text()).then(t=>console.log(t.slice(0,160)),e=>{console.log("нет ответа: "+e.message);process.exit(1)})' 2>&1) \
			&& g "изнутри контейнера: $$out" || b "изнутри контейнера: $$out"; \
	else \
		b 'контейнер приложения не запущен — дальше про маршрут смотреть нечего'; \
		i 'поднять: make prod-pull && make prod-up, потом make prod-logs'; \
	fi; \
	echo 'Схема базы'; \
	applied=$$($(PROD) exec -T db psql -U survey -d survey -tAc \
		'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null | tr -d '[:space:]'); \
	files=''; \
	if [ -n "$$app" ]; then \
		files=$$(docker exec "$$app" sh -c 'ls -1 $${MIGRATIONS_DIR:-/app/migrations}/*.sql 2>/dev/null | wc -l' 2>/dev/null | tr -d '[:space:]'); \
	fi; \
	if [ -z "$$applied" ]; then \
		b 'учёта миграций в базе нет — их не накатывали ни разу: make prod-migrate'; \
		i 'пустая база отвечает на select 1, поэтому status: ok этого не ловит'; \
	elif [ -z "$$files" ]; then g "накачено миграций: $$applied (сверить не с чем — контейнер не поднят)"; \
	elif [ "$$applied" -eq "$$files" ]; then g "миграции накачены полностью: $$applied из $$files"; \
	elif [ "$$applied" -lt "$$files" ]; then b "накачены не все: $$applied из $$files — make prod-migrate"; \
	else b "в базе миграций больше, чем в образе ($$applied против $$files): образ старее базы"; \
	fi; \
	echo 'Инфраструктура хоста'; \
	if docker network inspect proxy-net >/dev/null 2>&1; then g 'сеть proxy-net есть'; \
		else b 'сети proxy-net нет: docker network create proxy-net'; fi; \
	proxy=$$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | awk -F'\t' '$$2 ~ /nginx-proxy/ && $$2 !~ /companion|acme/ {print $$1; exit}'); \
	acme=$$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | awk -F'\t' '$$2 ~ /acme-companion|letsencrypt-nginx-proxy-companion/ {print $$1; exit}'); \
	if [ -n "$$proxy" ]; then g "nginx-proxy: $$proxy ($$(docker inspect -f '{{.Config.Image}}' $$proxy))"; \
		else b 'nginx-proxy в docker не найден'; fi; \
	if [ -n "$$acme" ]; then g "acme-companion: $$acme ($$(docker inspect -f '{{.Config.Image}}' $$acme))"; \
		else b 'acme-companion в docker не найден — сертификат выпускать некому'; fi; \
	if [ -z "$$proxy" ]; then \
		i 'кто-то всё же слушает 443, иначе браузер не дошёл бы до TLS. Кандидаты:'; \
		systemctl is-active --quiet nginx 2>/dev/null && i 'системный nginx на хосте активен (схема bitrix-env, а не proxy-net)'; \
		docker ps --format '  {{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null | grep -E ':(80|443)->' || true; \
	fi; \
	if [ -n "$$proxy" ] && [ -n "$$dom" ]; then \
		docker exec "$$proxy" grep -qs -- "$$dom" /etc/nginx/conf.d/default.conf \
			&& g 'прокси знает наш домен (vhost создан)' \
			|| b 'в конфиге прокси нашего домена нет — он не видит контейнер'; \
		docker exec "$$proxy" test -f "/etc/nginx/certs/$$dom.crt" \
			&& g 'сертификат на месте' \
			|| b "сертификата нет: /etc/nginx/certs/$$dom.crt — снаружи это и есть ERR_SSL_UNRECOGNIZED_NAME_ALERT"; \
	fi; \
	echo 'Маршрут через прокси, с петли'; \
	if [ -n "$$dom" ]; then \
		h=$${dom%%,*}; \
		probe 'http  по имени хоста' "--header Host:$$h http://127.0.0.1/api/health" i; \
		probe 'https через SNI     ' "--resolve $$h:443:127.0.0.1 https://$$h/api/health" b; \
	fi; \
	echo 'Снаружи'; \
	if [ -n "$$dom" ]; then \
		ip=$$(getent hosts "$$dom" 2>/dev/null | awk '{print $$1; exit}'); \
		if [ -n "$$ip" ]; then g "DNS: $$dom -> $$ip"; else b "DNS: $$dom не резолвится"; fi; \
		probe 'http ' "http://$$dom/api/health" i; \
		probe 'https' "https://$$dom/api/health" i; \
		i 'обе строки выше сняты С САМОГО ХОСТА: обращение к своему публичному адресу часто'; \
		i 'не проходит (hairpin NAT), и это не диагноз. Верить надо блоку выше.'; \
	fi; \
	if [ -z "$$app" ]; then \
		i 'вывод: контейнера нет, поэтому прокси и не создал vhost — всё про маршрут ниже'; \
		i 'следствие, а не причина. Начинать надо с make prod-up.'; \
	fi; \
	:

# --- Обновление файлов на сервере --------------------------------------------
#
# Репозитория на сервере нет, поэтому свежие `compose.yaml` и `Makefile` приезжают
# по HTTPS. Скачиваем В ФАЙЛ через `mktemp`: оборванная загрузка в `curl | bash`
# выполняется кусками, а предсказуемое имя в общем `/tmp` можно подложить симлинком.
#
# `override` для REF — про безопасность, а не про стиль. Значение подставляется в URL
# макросом, то есть раскрывается ДО всякого шелла: `make host-update REF='$$(shell …)'`
# выполнил бы код даже под `-n`, в режиме «только показать», а `REF=../../чужой/репо`
# увёл бы загрузку в другой репозиторий — curl схлопывает `/../` в пути сам.
# Оператору ветки не нужны, поэтому переменной просто нет.
override REF := main
RAW := https://raw.githubusercontent.com/bx-shef/polls/main

host-update: ## Обновить на сервере compose.yaml и Makefile из main
	@test ! -f package.json || { echo 'В репозитории это лишнее: файлы и так из git.' >&2; exit 1; }
	@tmp=$$(mktemp) && curl -fsS -o "$$tmp" '$(RAW)/deploy/compose.yaml' \
		&& chmod 644 "$$tmp" && mv "$$tmp" compose.yaml && echo 'compose.yaml обновлён'
	@tmp=$$(mktemp) && curl -fsS -o "$$tmp" '$(RAW)/Makefile' \
		&& chmod 644 "$$tmp" && mv "$$tmp" Makefile && echo 'Makefile обновлён'
