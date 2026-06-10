#!/bin/bash
# SessionStart-хук: прогрев среды для веб-сессий Claude Code.
# Ставит зависимости (pnpm), чтобы typecheck/test/verify работали сразу.
# Идемпотентен и неинтерактивен.
set -euo pipefail

# Только в удалённой среде (Claude Code on the web); локально — пропуск.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

dir="${CLAUDE_PROJECT_DIR:-.}"
[ -d "$dir" ] || { echo "session-start: каталог не найден: $dir" >&2; exit 1; }
cd "$dir"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
