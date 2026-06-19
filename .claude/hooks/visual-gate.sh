#!/bin/bash
# Stop-хук: детерминированный визуальный гейт контура A (issue #13).
# Срабатывает, когда сессия тронула UI-поверхности (фронт/фикстуры/конфиг гейта):
# прогоняет скриншот-регрессию (`pnpm test:visual`) и БЛОКИРУЕТ остановку при расхождении
# с эталоном — «правка UI не готова, пока не увидена глазами и не сверена».
#
# Принципы:
# - Узкий триггер: чистое ядро (src/, docs/, миграции) гейт не трогает → мгновенный выход.
# - Мягкая деградация: нет браузера (локальный dev без `pnpm visual:install`) → пропуск,
#   НЕ блок (инфраструктурная нехватка ≠ регрессия). В удалённой среде браузер предустановлен.
# - Блок только на реальном провале сверки (exit 2 → stderr возвращается агенту).
set -uo pipefail

dir="${CLAUDE_PROJECT_DIR:-.}"
cd "$dir" 2>/dev/null || exit 0

# 1) Тронуты ли UI-поверхности? (рабочее дерево + коммиты ветки относительно main)
ui_re='^(app|pages|components|layouts|composables|assets|public|test/visual)/|^playwright\.config\.'
changed="$(
  { git status --porcelain 2>/dev/null | sed 's/^...//'
    git diff --name-only main...HEAD 2>/dev/null
    git diff --name-only HEAD~1..HEAD 2>/dev/null
  } | sort -u
)"
if ! printf '%s\n' "$changed" | grep -Eq "$ui_re"; then
  exit 0  # UI не затронут — гейт не применяется
fi

# 2) Есть ли браузер? Нет — пропуск без блокировки.
browsers_dir="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if ! ls -d "$browsers_dir"/chromium-* >/dev/null 2>&1; then
  echo "visual-gate(#13): chromium не установлен — пропуск. Установите: pnpm visual:install" >&2
  exit 0
fi

# 3) Прогон скриншот-регрессии.
if pnpm -s test:visual >/tmp/visual-gate.log 2>&1; then
  exit 0
fi

cat >&2 <<'MSG'
✗ Визуальный гейт #13: рендер разошёлся с эталоном (или эталон отсутствует).
  Это значит, что UI-изменение не сверено глазами. Действия:
    1. Посмотрите diff: playwright-report/ (npx playwright show-report) и test-results/.
    2. Если регрессия — почините раскладку/состояния/брейкпоинты/тему.
    3. Если изменение НАМЕРЕННОЕ — обновите эталон осознанно: pnpm test:visual:update
       (и проверьте обновлённые .png глазами перед коммитом).
  Лог прогона: /tmp/visual-gate.log
MSG
exit 2
