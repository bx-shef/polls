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

# ── Рантайм ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# .output самодостаточен (nitro бандлит прод-зависимости) — node_modules не нужны.
COPY --from=build /app/.output ./.output
# Непривилегированный пользователь (образ node уже содержит `node`).
USER node
EXPOSE 3000
# Nitro слушает PORT (по умолчанию 3000), HOST 0.0.0.0 — чтобы был доступен из сети контейнера.
ENV PORT=3000 HOST=0.0.0.0
CMD ["node", ".output/server/index.mjs"]
