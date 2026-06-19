#!/bin/bash
# Stop-хук: детерминированный визуальный гейт контура A (issue #13).
# Срабатывает, когда сессия тронула UI-поверхности (фронт/фикстуры/конфиг гейта):
# прогоняет скриншот-регрессию (`pnpm test:visual`) и БЛОКИРУЕТ остановку при расхождении
# с эталоном — «правка UI не готова, пока не увидена глазами и не сверена».
#
# Принципы:
# - Узкий триггер: чистое ядро (src/, docs/, миграции) гейт не трогает → мгновенный выход.
# - Мягкая деградация: нет pnpm/браузера (локальный dev без `pnpm visual:install`) →
#   пропуск, НЕ блок (инфраструктурная нехватка ≠ регрессия). В удалённой среде браузер
#   предустановлен (chromium в каталоге PLAYWRIGHT_BROWSERS_PATH).
# - Блок только на реальном провале сверки (exit 2 → stderr возвращается агенту).
#
# Безопасность: хук и `package.json`-скрипты берутся из РАБОЧЕГО ДЕРЕВА текущей ветки
# (та же модель доверия, что у session-start.sh). На недоверенной ветке ревьюйте
# изменения в `.claude/hooks/` и в скрипте `test:visual` перед запуском сессии.
#
# `-e` намеренно опущен: ветвление через `if` + явные `exit`; errexit здесь только мешал бы.
set -uo pipefail

dir="${CLAUDE_PROJECT_DIR:-.}"
cd "$dir" 2>/dev/null || exit 0

# pnpm доступен? Нет — пропуск без блокировки.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "visual-gate(#13): pnpm не найден в PATH — пропуск." >&2
  exit 0
fi

# Тронуты ли UI-поверхности? Только `git diff --name-only` (корректно для rename: отдаёт
# новое имя, без парсинга porcelain-статусов). Эталоны (__screenshots__) исключаем — их
# обновление через test:visual:update само по себе не UI-регрессия. Ветка vs main, с
# настоящим fallback на последний коммит (detached/orphan/нет main).
changed="$(
  { git diff --name-only HEAD 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
    git diff --name-only main...HEAD 2>/dev/null || git diff --name-only HEAD~1..HEAD 2>/dev/null
  } | grep -v '/__screenshots__/' | sort -u
)"
ui_re='^(app|pages|components|layouts|composables|assets|public|test/visual)/|^playwright\.config\.'
if ! printf '%s\n' "$changed" | grep -Eq "$ui_re"; then
  exit 0  # UI не затронут — гейт не применяется
fi

# Есть ли браузер? Нет — пропуск без блокировки.
browsers_dir="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if ! ls -d "$browsers_dir"/chromium-* >/dev/null 2>&1; then
  echo "visual-gate(#13): chromium не найден в $browsers_dir — пропуск. Установите: pnpm visual:install" >&2
  exit 0
fi

# Прогон скриншот-регрессии. Лог — во временный файл (mktemp: без гонок/симлинк-атак в /tmp).
log="$(mktemp "${TMPDIR:-/tmp}/visual-gate.XXXXXX")"
if pnpm -s test:visual >"$log" 2>&1; then
  rm -f "$log"
  exit 0
fi

cat >&2 <<MSG
✗ Визуальный гейт #13: рендер разошёлся с эталоном (или эталон отсутствует).
  Это значит, что UI-изменение не сверено глазами. Действия:
    1. Посмотрите diff: playwright-report/ (npx playwright show-report) и test-results/.
    2. Если регрессия — почините раскладку/состояния/брейкпоинты/тему.
    3. Если изменение НАМЕРЕННОЕ (или новый экран без эталона) — обновите эталон осознанно:
       pnpm test:visual:update (и проверьте обновлённые .png глазами перед коммитом).
  Лог прогона: $log
MSG
exit 2
