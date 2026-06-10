# Полная локальная проверка одной командой (Windows, PowerShell).
# Запуск:  powershell -ExecutionPolicy Bypass -File scripts\check.ps1
# Делает: установка зависимостей -> типы -> тесты -> расчёт итога.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host '> pnpm install'
try { corepack enable | Out-Null } catch {}
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { pnpm install }

Write-Host '> typecheck'
pnpm -s typecheck
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '> test'
pnpm -s test
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '> verify (итог на 4 уровнях)'
pnpm -s verify
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host 'OK: типы + тесты + итог посчитаны.'
