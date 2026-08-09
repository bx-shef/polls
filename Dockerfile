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
# Затем исходники и сборка Nuxt → /app/.output (самодостаточный сервер).
COPY . .
RUN pnpm build

# ── Зависимости бутстрапа телеметрии ─────────────────────────────────────────
# ⚠️ Ставятся ОТДЕЛЬНО от приложения и НЕ через pnpm-воркспейс. Причина не в аккуратности: Nitro
# бандлит прод-зависимости в `.output`, а забандленную библиотеку авто-инструментирование OTel
# подменить уже не может — require-хуки ставятся до загрузки, а бандл загружает свою копию сам.
# Версии в `otel-preload-package.json` ТОЧНЫЕ: расхождение версии `@opentelemetry/api` между бандлом
# приложения и preload даёт молчаливый вечный no-op — трейсов нет, ошибки нет.
# ⚠️ Раскладка «бутстрап рядом со своими node_modules» обязательна: ESM резолвит зависимости ВВЕРХ по
# дереву каталогов и `NODE_PATH` не читает вовсе (документированное поведение Node, проверено запуском
# в раскладке образа — с `NODE_PATH` получался `ERR_MODULE_NOT_FOUND` и мёртвый процесс).
RUN mkdir -p /otel && cp otel-preload-package.json /otel/package.json \
    && cd /otel && npm install --omit=dev --no-audit --no-fund

# ── Рантайм ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# .output самодостаточен (nitro бандлит прод-зависимости, включая pg) — node_modules не нужны.
COPY --from=build /app/.output ./.output
# Миграции применяются на старте (src/store/migrate, #6) — нужны в рантайме рядом с cwd (/app).
COPY --from=build /app/migrations ./migrations
# Бутстрап телеметрии и его зависимости. Без `OTEL_EXPORTER_OTLP_ENDPOINT` файл выходит на первой
# строке и SDK не грузит — то есть в обычной установке это мёртвый вес в несколько мегабайт и ноль
# накладных в рантайме.
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
