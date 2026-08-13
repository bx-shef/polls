# Многоступенчатая сборка Nuxt-приложения (контур A + дашборд контура B).
# Финальный образ — только self-contained .output (nitro node-server) + node:
# без исходников, dev-зависимостей и pnpm-кэша.

# ── Сборка ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
# corepack даёт pnpm нужной версии из packageManager в package.json (детерминизм).
RUN corepack enable
# Сначала манифесты — слой зависимостей кешируется, пока они не меняются.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Зависимости бутстрапа телеметрии ─────────────────────────────────────────
# ⚠️ Ставятся ОТДЕЛЬНО от приложения: бутстрап грузится ДО сборки, и его модулей в `.output` нет —
# Nitro бандлит только то, что импортирует само приложение.
# Версии в `otel-preload-package.json` ТОЧНЫЕ: расхождение версии `@opentelemetry/api` между бандлом
# приложения и preload даёт молчаливый вечный no-op — трейсов нет, ошибки нет.
# ⚠️ Ставим `npm ci` по ЗАКОММИЧЕННОМУ лок-файлу и с `--ignore-scripts`. Прямых зависимостей четыре, а
# приезжает 71 пакет: без лока 67 транзитивных резолвились бы заново на каждой сборке, и один
# (`protobufjs`) выполнял бы `postinstall` прямо в сборке образа. Этот код грузится через `--import`
# ДО приложения, в том же процессе и с теми же правами — то есть позиция строже, чем у бандла
# приложения, а не мягче. Тот же довод, по которому в проекте сторонние GitHub-actions запиннены на
# полный commit-SHA. Проверено запуском: с `--ignore-scripts` набор пакетов тот же и трейсы уходят —
# `protobufjs` приезжает только через gRPC/proto-экспортёры, которых бутстрап не импортирует.
# ⚠️ Раскладка «бутстрап рядом со своими node_modules» обязательна: ESM резолвит зависимости ВВЕРХ по
# дереву каталогов и `NODE_PATH` не читает вовсе (документированное поведение Node, проверено запуском
# в раскладке образа — с `NODE_PATH` получался `ERR_MODULE_NOT_FOUND` и мёртвый процесс).
# Стоит ДО `COPY . .`, иначе правка любого исходника переставляла бы 71 пакет заново.
COPY otel-preload-package.json /otel/package.json
COPY otel-preload-package-lock.json /otel/package-lock.json
RUN cd /otel && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Затем исходники и сборка Nuxt → /app/.output (самодостаточный сервер).
COPY . .
RUN pnpm build

# ── Рантайм ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# .output самодостаточен (nitro бандлит прод-зависимости, включая pg) — node_modules не нужны.
COPY --from=build /app/.output ./.output
# Миграции применяются на старте (src/store/migrate, #6) — нужны в рантайме рядом с cwd (/app).
COPY --from=build /app/migrations ./migrations
# Бутстрап телеметрии и его зависимости. Без `OTEL_EXPORTER_OTLP_ENDPOINT` файл выходит на первой
# строке и SDK не грузит — то есть в обычной установке это мёртвый вес ~34 МБ (52 МБ на диске) и ноль
# накладных в рантайме. Основную часть тянет `sdk-node` вместе с gRPC-экспортёром, который мы не
# используем, — кандидат на замену `sdk-node` → `sdk-trace-node` отдельной задачей.
COPY --from=build /otel/node_modules ./otel/node_modules
COPY --from=build /app/otel.instrument.mjs ./otel/instrument.mjs
# Непривилегированный пользователь (образ node уже содержит `node`).
USER node
EXPOSE 3000
# Nitro слушает PORT (по умолчанию 3000), HOST 0.0.0.0 — чтобы был доступен из сети контейнера.
ENV PORT=3000 HOST=0.0.0.0
# ⚠️ `--import` грузит бутстрап ДО приложения. Путь — внутри `/app/otel`, рядом с его `node_modules`:
# ESM ищет зависимости вверх по дереву каталогов, и лежи бутстрап в `/app`, он бы их не нашёл.
ENV NODE_OPTIONS=--import=/app/otel/instrument.mjs
CMD ["node", ".output/server/index.mjs"]
