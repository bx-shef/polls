#!/usr/bin/env bash
# Полная локальная проверка одной командой (Linux/macOS).
# Запуск:  bash scripts/check.sh
# Делает: установка зависимостей → типы → тесты → расчёт итога.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ pnpm install (--frozen-lockfile)"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

echo "▶ typecheck"
pnpm -s typecheck

echo "▶ test"
pnpm -s test

echo "▶ verify (итог на 4 уровнях)"
pnpm -s verify

echo "✅ Готово: типы + тесты + итог посчитаны."
