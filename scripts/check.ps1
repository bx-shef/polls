# Полная локальная проверка одной командой (Windows, PowerShell).
# Запуск:  powershell -ExecutionPolicy Bypass -File scripts\check.ps1
# Делает: установка зависимостей -> типы -> тесты -> расчёт итога.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host '> pnpm install (--frozen-lockfile)'
try { corepack enable | Out-Null } catch {}
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '> typecheck (ядро)'
pnpm -s typecheck
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '> check:boundary (граница ~core)'
pnpm -s check:boundary
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '> typecheck:app + typecheck:server (vue-tsc app/ + server/)'
pnpm -s nuxt:prepare
if ($LASTEXITCODE -ne 0) { exit 1 }
pnpm -s typecheck:app
if ($LASTEXITCODE -ne 0) { exit 1 }
pnpm -s typecheck:server
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '> lint (забытый await, типовые правила - #165)'
pnpm -s lint
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '> test (+покрытие, пороги в vitest.config.ts)'
pnpm -s test:cov
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '> verify (итог на 4 уровнях)'
pnpm -s verify
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host 'OK: типы + линт + тесты + итог посчитаны.'
