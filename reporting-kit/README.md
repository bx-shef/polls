# Reporting Kit (обезличенный шаблон)

Переносимый набор для работы с AI-агентом (Claude Code) и отчётности в Telegram.
Скопируй в корень своего репозитория и адаптируй под проект.

## Состав

| Путь | Назначение |
| --- | --- |
| `CLAUDE.md` | Правила работы с репозиторием, операционная дисциплина (GitHub API rate limits, хук Bitrix24 `B24_HOOK___SUFFIX`) + типовые сценарии review и merge. |
| `docs/project-map.md` | Шаблон карты проекта (источник для отчётов). |
| `docs/reports/*` | Канон промптов отчётов (эталон, зеркалится в навыки). |
| `.claude/skills/`, `.claude/commands/` | Навыки/команды: `/report-status`, `/report-digest`, `/report-questions`. |
| `scripts/tg-send.sh` | Безопасная отправка текста в Telegram. |
| `scripts/check-tg.sh`, `check-skills.sh`, `check-docs.sh` (+ `.ps1`) | Проверки kit. |
| `.github/workflows/docs-links.yml` | CI: гоняет проверки на PR/push. |
| `.github/scripts/check_doc_links.py` | Оффлайн-проверка ссылок в документации. |
| `.env.example` | Шаблон переменных Telegram. |

## Быстрый старт

1. Скопируй содержимое в корень репозитория.
2. Создай бота у @BotFather, получи токен.
3. Добавь бота в нужный канал/группу админом, узнай `chat_id`
   (`https://api.telegram.org/bot<TOKEN>/getUpdates`).
4. Заполни переменные:
   - локально: `cp .env.example .env && chmod 600 .env`, затем впиши значения;
   - в облаке/CI: задай переменные окружения и добавь `api.telegram.org`
     в сетевой allowlist.
5. Адаптируй `docs/project-map.md` и таблицу «Связанные репозитории» в `CLAUDE.md`.
6. Проверь: `bash scripts/check-tg.sh && bash scripts/check-skills.sh && bash scripts/check-docs.sh`.

## Переменные

| Переменная | Что это |
| --- | --- |
| `TG_BOT_TOKEN` | токен бота (@BotFather → /newbot) |
| `TG_CHAT_ID` | id канала назначения (приватный — `-100...`, публичный — `@username`) |

## Принцип отчётности

Навыки **только готовят** текст отчёта. Отправляет `scripts/tg-send.sh` —
и только по явной команде «шли», не раньше. Все отчёты идут в один канал
(`TG_CHAT_ID`). `tg-send.sh` без токена или `chat_id` намеренно отказывает.

## Навыки

| Навык | Команда | Что делает |
| --- | --- | --- |
| report-status | `/report-status` | срез состояния проекта по `docs/project-map.md` |
| report-digest | `/report-digest` | дайджест по репозиториям за период (кратко + подробно) |
| report-questions | `/report-questions` | вопросник заказчику по открытым пунктам карты |

Канон промптов — `docs/reports/`. Тела `.claude/skills/*/SKILL.md` — зеркало канона;
идентичность проверяет `scripts/check-skills.sh` и CI.
