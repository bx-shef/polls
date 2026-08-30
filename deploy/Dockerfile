# syntax=docker/dockerfile:1
#
# Три стадии: зависимости → сборка → runtime.
# Зависимости отдельно, чтобы правка исходников не тянула переустановку пакетов;
# runtime — только вывод Nitro, без pnpm, без devDependencies, без исходников.

# ---------- 1. Зависимости ----------
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: postinstall зовёт `nuxt prepare`, а исходников на этой стадии ещё нет.
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store \
    && pnpm install --frozen-lockfile --ignore-scripts

# ---------- 2. Сборка ----------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---------- 3. Runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ARG APP_VERSION=dev
ENV NODE_ENV=production \
    NITRO_PORT=3000 \
    NITRO_HOST=0.0.0.0 \
    MIGRATIONS_DIR=/app/migrations \
    APP_VERSION=$APP_VERSION

COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/server/db/migrations ./migrations
# Запускалка миграций кладётся внутрь .output/server, чтобы `drizzle-orm` и `postgres`
# разрешались из .output/server/node_modules — второй копии зависимостей в образе нет.
COPY --from=build --chown=node:node /app/scripts/migrate.mjs ./.output/server/migrate.mjs

USER node
EXPOSE 3000

# Проверяем живость, а не готовность: `/api/health` отвечает 503, когда недоступна база,
# и перезапуск контейнера этого не лечит. Здесь важно только то, что сервер отвечает.
HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(()=>process.exit(0),()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
