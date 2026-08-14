#!/usr/bin/env bash
# Полная локальная проверка одной командой (Linux/macOS).
# Запуск:  bash scripts/check.sh
# Делает: установка зависимостей → типы → тесты → расчёт итога.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ pnpm install (--frozen-lockfile)"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

echo "▶ typecheck (ядро)"
pnpm -s typecheck

echo "▶ check:boundary (граница ~core)"
pnpm -s check:boundary

echo "▶ lint (забытый await + recommended — #165; сам зовёт nuxt prepare)"
pnpm -s lint

echo "▶ typecheck:app + typecheck:server (vue-tsc app/ + server/)"
pnpm -s typecheck:app
pnpm -s typecheck:server

echo "▶ test (+покрытие, пороги в vitest.config.ts)"
pnpm -s test:cov

echo "▶ verify (итог на 4 уровнях)"
pnpm -s verify

echo "✅ Готово: типы (ядро+граница+app) + линт + тесты + итог посчитаны."
